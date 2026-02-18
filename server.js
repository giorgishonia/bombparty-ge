const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadLocalEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) return;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    });
}

loadLocalEnv();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

app.use(express.json({ limit: '1mb' }));

// Enable CORS for Express
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    next();
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// ============== RANKED / STATS STORAGE ==============
const SUPABASE_URL_ENV = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY_ENV = process.env.SUPABASE_ANON_KEY || '';
let runtimeSupabaseConfig = { url: '', anonKey: '' };

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const SUPABASE_AUTH_CACHE_TTL_MS = 30 * 1000;

const authSessions = new Map(); // sessionId -> { user, expiresAt }
const supabaseAuthCache = new Map(); // token -> { user, expiresAt }

const DEFAULT_MMR = 1000;
const RANKED_K_FACTOR = 38;
const RANKED_DELTA_CAP = 55;
const LOCAL_PROFILE_STORE = new Map(); // playerId -> profile stats
const LOCAL_MATCH_STORE = []; // in-memory fallback match history
const PLAYER_VISUAL_CACHE = new Map(); // playerId -> { username, avatarUrl }

function cachePlayerVisual(playerId, meta = {}) {
    if (!playerId) return;
    const username = sanitizeText(meta.username || '', 40) || null;
    const avatarUrl = sanitizeText(meta.avatarUrl || '', 500) || null;
    const current = PLAYER_VISUAL_CACHE.get(playerId) || {};
    PLAYER_VISUAL_CACHE.set(playerId, {
        username: username || current.username || null,
        avatarUrl: avatarUrl || current.avatarUrl || null
    });
}

function withPlayerVisuals(profileRow = {}) {
    const cached = PLAYER_VISUAL_CACHE.get(profileRow.id) || {};
    return {
        ...profileRow,
        username: profileRow.username || cached.username || null,
        avatar_url: profileRow.avatar_url || profileRow.avatarUrl || cached.avatarUrl || null
    };
}

function getSupabaseConfig() {
    return {
        url: runtimeSupabaseConfig.url || SUPABASE_URL_ENV || '',
        anonKey: runtimeSupabaseConfig.anonKey || SUPABASE_ANON_KEY_ENV || ''
    };
}

function isSupabaseConfigured() {
    const { url, anonKey } = getSupabaseConfig();
    return Boolean(url && anonKey && url.startsWith('http'));
}

function setSupabaseRuntimeConfig(url, anonKey) {
    if (typeof url === 'string' && typeof anonKey === 'string' && url.trim() && anonKey.trim()) {
        runtimeSupabaseConfig = { url: url.trim(), anonKey: anonKey.trim() };
        console.log('✓ Supabase runtime config updated');
    }
}

async function supabaseRequest(method, resourcePath, { query = '', body = null, prefer = '' } = {}) {
    if (!isSupabaseConfigured()) throw new Error('Supabase is not configured');
    const { url, anonKey } = getSupabaseConfig();
    const endpoint = `${url}/rest/v1/${resourcePath}${query ? `?${query}` : ''}`;

    const headers = {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`
    };
    if (body !== null) headers['Content-Type'] = 'application/json';
    if (prefer) headers['Prefer'] = prefer;

    const response = await fetch(endpoint, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Supabase ${method} ${resourcePath} failed (${response.status}): ${errorText}`);
    }

    if (response.status === 204) return [];
    return response.json();
}

function createDefaultProfile(playerId, displayName = 'Player') {
    return {
        id: playerId,
        display_name: displayName || 'Player',
        mmr: DEFAULT_MMR,
        highest_mmr: DEFAULT_MMR,
        wins: 0,
        losses: 0,
        games_played: 0,
        ranked_games: 0,
        total_guessed_words: 0,
        best_game_words: 0,
        longest_game_seconds: 0,
        total_game_seconds: 0,
        total_score: 0,
        updated_at: new Date().toISOString()
    };
}

function normalizeProfileRow(row, fallbackName = 'Player') {
    const base = createDefaultProfile(row.id, row.display_name || fallbackName);
    return {
        ...base,
        ...row,
        display_name: row.display_name || fallbackName || base.display_name,
        mmr: Number(row.mmr ?? base.mmr),
        highest_mmr: Number(row.highest_mmr ?? row.mmr ?? base.highest_mmr),
        wins: Number(row.wins ?? 0),
        losses: Number(row.losses ?? 0),
        games_played: Number(row.games_played ?? 0),
        ranked_games: Number(row.ranked_games ?? 0),
        total_guessed_words: Number(row.total_guessed_words ?? 0),
        best_game_words: Number(row.best_game_words ?? 0),
        longest_game_seconds: Number(row.longest_game_seconds ?? 0),
        total_game_seconds: Number(row.total_game_seconds ?? 0),
        total_score: Number(row.total_score ?? 0)
    };
}

async function getProfilesByIds(playerEntries = []) {
    const ids = [...new Set(playerEntries.map(p => p.id).filter(Boolean))];
    if (ids.length === 0) return new Map();

    const fallbackProfiles = new Map();
    playerEntries.forEach(p => {
        const existing = LOCAL_PROFILE_STORE.get(p.id);
        fallbackProfiles.set(p.id, existing ? { ...existing } : createDefaultProfile(p.id, p.name));
    });

    if (!isSupabaseConfigured()) return fallbackProfiles;

    try {
        const idList = ids.map(id => encodeURIComponent(id)).join(',');
        const rows = await supabaseRequest('GET', 'player_profiles', {
            query: `select=*&id=in.(${idList})`
        });

        rows.forEach(row => {
            fallbackProfiles.set(row.id, normalizeProfileRow(row, row.display_name));
        });
        return fallbackProfiles;
    } catch (error) {
        console.error('Failed to load profiles from Supabase:', error.message);
        return fallbackProfiles;
    }
}

async function upsertProfiles(profiles = []) {
    if (profiles.length === 0) return;

    // Always keep local cache updated.
    profiles.forEach(profile => {
        LOCAL_PROFILE_STORE.set(profile.id, normalizeProfileRow(profile, profile.display_name));
    });

    if (!isSupabaseConfigured()) return;

    try {
        await supabaseRequest('POST', 'player_profiles', {
            query: 'on_conflict=id',
            body: profiles,
            prefer: 'resolution=merge-duplicates,return=minimal'
        });
    } catch (error) {
        console.error('Failed to upsert profiles to Supabase:', error.message);
    }
}

async function insertRankedMatch(matchRow) {
    LOCAL_MATCH_STORE.unshift(matchRow);
    if (LOCAL_MATCH_STORE.length > 2000) LOCAL_MATCH_STORE.length = 2000;

    if (!isSupabaseConfigured()) return;
    try {
        await supabaseRequest('POST', 'ranked_matches', {
            body: matchRow,
            prefer: 'return=minimal'
        });
    } catch (error) {
        console.error('Failed to insert ranked match:', error.message);
    }
}

function calculateRankMmrLabel(mmr) {
    if (mmr >= 2400) return 'Grandmaster';
    if (mmr >= 2200) return 'Master';
    if (mmr >= 2050) return 'Diamond I';
    if (mmr >= 1900) return 'Diamond II';
    if (mmr >= 1750) return 'Platinum I';
    if (mmr >= 1625) return 'Platinum II';
    if (mmr >= 1500) return 'Gold I';
    if (mmr >= 1380) return 'Gold II';
    if (mmr >= 1260) return 'Silver I';
    if (mmr >= 1140) return 'Silver II';
    if (mmr >= 1020) return 'Bronze I';
    return 'Bronze II';
}

function nowMs() {
    return Date.now();
}

function parseCookies(cookieHeader = '') {
    const cookies = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
    cookieHeader.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        cookies[key] = decodeURIComponent(value);
    });
    return cookies;
}

function signSessionPayload(payload) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function createSession(user) {
    const sessionId = crypto.randomBytes(24).toString('hex');
    const expiresAt = nowMs() + SESSION_TTL_MS;
    authSessions.set(sessionId, { user, expiresAt });
    return { sessionId, expiresAt };
}

function getSession(sessionId) {
    const session = authSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= nowMs()) {
        authSessions.delete(sessionId);
        return null;
    }
    return session;
}

function setSessionCookie(res, sessionId, expiresAt) {
    const isSecure = process.env.NODE_ENV === 'production';
    const maxAgeSec = Math.max(1, Math.floor((expiresAt - nowMs()) / 1000));
    res.setHeader('Set-Cookie', `bp_session=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${isSecure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
    const isSecure = process.env.NODE_ENV === 'production';
    res.setHeader('Set-Cookie', `bp_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${isSecure ? '; Secure' : ''}`);
}

function getAuthUserFromSessionCookie(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const sid = cookies.bp_session;
    if (!sid) return null;
    const session = getSession(sid);
    return session?.user || null;
}

function extractBearerTokenFromHeaders(headers = {}) {
    const authHeader = headers.authorization || headers.Authorization;
    if (!authHeader || typeof authHeader !== 'string') return '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
    return authHeader.slice(7).trim();
}

function findDiscordIdentity(identities = []) {
    if (!Array.isArray(identities)) return null;
    return identities.find(identity => identity?.provider === 'discord') || null;
}

function mapSupabaseUser(rawUser) {
    const appProvider = rawUser?.app_metadata?.provider || '';
    const providers = Array.isArray(rawUser?.app_metadata?.providers) ? rawUser.app_metadata.providers : [];
    const identity = findDiscordIdentity(rawUser?.identities || []);
    const isDiscordProvider = appProvider === 'discord' || providers.includes('discord') || Boolean(identity);
    if (!isDiscordProvider) return null;

    const userMeta = rawUser?.user_metadata || {};
    const preferredName = userMeta.full_name || userMeta.name || userMeta.global_name || userMeta.preferred_username || rawUser.email || 'Discord User';
    const displayName = sanitizeName(preferredName, 20);
    return {
        id: `discord_${rawUser.id}`,
        discordId: identity?.identity_data?.user_id || identity?.id || null,
        username: sanitizeText(userMeta.user_name || userMeta.username || rawUser.email || displayName, 40) || 'discord',
        displayName,
        avatar: userMeta.avatar_url || null,
        provider: 'discord',
        supabaseUserId: rawUser.id
    };
}

async function verifySupabaseAccessToken(accessToken) {
    if (!accessToken) return null;
    const cached = supabaseAuthCache.get(accessToken);
    if (cached && cached.expiresAt > nowMs()) return cached.user;

    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) return null;

    const response = await fetch(`${url}/auth/v1/user`, {
        headers: {
            apikey: anonKey,
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        return null;
    }

    const rawUser = await response.json();
    const user = mapSupabaseUser(rawUser);
    if (!user) return null;
    cachePlayerVisual(user.id, { username: user.username, avatarUrl: user.avatar });

    supabaseAuthCache.set(accessToken, { user, expiresAt: nowMs() + SUPABASE_AUTH_CACHE_TTL_MS });
    return user;
}

async function getAuthUserFromRequest(req) {
    const accessToken = extractBearerTokenFromHeaders(req.headers || {});
    if (accessToken) {
        try {
            const user = await verifySupabaseAccessToken(accessToken);
            if (user) return user;
        } catch (error) {
            console.error('Supabase token verification failed:', error.message);
        }
    }

    // Legacy fallback for pre-existing local session auth.
    return getAuthUserFromSessionCookie(req);
}

// ============== SECURITY: INPUT SANITIZATION ==============
function sanitizeText(text, maxLength = 50) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/[<>&"'`]/g, '') // Remove dangerous chars
        .substring(0, maxLength)
        .trim();
}

function sanitizeName(name, maxLength = 20) {
    if (typeof name !== 'string') return 'სტუმარი';
    const sanitized = name
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/[<>&"'`]/g, '') // Remove dangerous chars
        .replace(/[\x00-\x1F\x7F]/g, '') // Remove control chars
        .substring(0, maxLength)
        .trim();
    return sanitized || 'სტუმარი';
}

// ============== SECURITY: RATE LIMITING ==============
const rateLimits = new Map(); // socketId -> { event: timestamp[] }

function isRateLimited(socketId, event, maxRequests = 10, windowMs = 1000) {
    const now = Date.now();
    const key = `${socketId}:${event}`;

    if (!rateLimits.has(key)) {
        rateLimits.set(key, []);
    }

    const timestamps = rateLimits.get(key);

    // Remove old timestamps outside the window
    while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
        timestamps.shift();
    }

    // Check if over limit
    if (timestamps.length >= maxRequests) {
        return true; // Rate limited
    }

    // Add current timestamp
    timestamps.push(now);
    return false;
}

// Clean up rate limit data periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of rateLimits.entries()) {
        // Remove entries older than 10 seconds
        while (timestamps.length > 0 && timestamps[0] < now - 10000) {
            timestamps.shift();
        }
        if (timestamps.length === 0) {
            rateLimits.delete(key);
        }
    }
}, 30000);

setInterval(() => {
    const now = nowMs();
    for (const [sessionId, session] of authSessions.entries()) {
        if (!session || session.expiresAt <= now) authSessions.delete(sessionId);
    }
    for (const [token, cached] of supabaseAuthCache.entries()) {
        if (!cached || cached.expiresAt <= now) supabaseAuthCache.delete(token);
    }
}, 60000);

// Load Georgian words
let WORDS = [];
let SYLLABLES = [];
let EASY_SYLLABLES = [];
let MEDIUM_SYLLABLES = [];
let HARD_SYLLABLES = [];

function loadWords() {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'ka_GE.txt'), 'utf8');
        const lines = data.split('\n');
        WORDS = lines
            .map(line => line.trim().split(' ')[0])
            .filter(word => word && word.length >= 2);

        // Extract common Georgian syllables (2-3 character combinations)
        const syllableMap = new Map();
        WORDS.forEach(word => {
            if (word.length >= 3) {
                for (let i = 0; i < word.length - 1; i++) {
                    const syl2 = word.substring(i, i + 2);
                    const syl3 = i < word.length - 2 ? word.substring(i, i + 3) : null;

                    syllableMap.set(syl2, (syllableMap.get(syl2) || 0) + 1);
                    if (syl3) {
                        syllableMap.set(syl3, (syllableMap.get(syl3) || 0) + 1);
                    }
                }
            }
        });

        // Get syllables that appear in many words (good difficulty range)
        const rankedSyllables = Array.from(syllableMap.entries())
            .filter(([syl, count]) => count >= 50 && count <= 15000 && syl.length >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 200);

        SYLLABLES = rankedSyllables.map(([syl]) => syl);

        // Split into 3 pools by frequency.
        // Higher frequency syllables are easier because they match more words.
        const total = rankedSyllables.length;
        const easySize = Math.max(1, Math.floor(total * 0.35));
        const mediumSize = Math.max(1, Math.floor(total * 0.35));

        EASY_SYLLABLES = rankedSyllables.slice(0, easySize).map(([syl]) => syl);
        MEDIUM_SYLLABLES = rankedSyllables.slice(easySize, easySize + mediumSize).map(([syl]) => syl);
        HARD_SYLLABLES = rankedSyllables.slice(easySize + mediumSize).map(([syl]) => syl);

        if (MEDIUM_SYLLABLES.length === 0) MEDIUM_SYLLABLES = [...EASY_SYLLABLES];
        if (HARD_SYLLABLES.length === 0) HARD_SYLLABLES = [...MEDIUM_SYLLABLES];

        console.log(`✓ Loaded ${WORDS.length} words and ${SYLLABLES.length} syllables`);
    } catch (err) {
        console.error('Error loading words:', err);
        // Fallback syllables
        SYLLABLES = ['ან', 'ის', 'ერ', 'ობ', 'ას', 'ით', 'ურ', 'ელ', 'არ', 'ებ'];
        EASY_SYLLABLES = [...SYLLABLES];
        MEDIUM_SYLLABLES = [...SYLLABLES];
        HARD_SYLLABLES = [...SYLLABLES];
    }
}

function extractYouTubeVideoId(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    const cleaned = sanitizeText(rawUrl, 500);
    if (!cleaned) return null;

    try {
        const url = new URL(cleaned);
        const host = (url.hostname || '').toLowerCase();

        if (host === 'youtu.be') {
            const id = (url.pathname || '').replace(/\//g, '').trim();
            return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }

        if (host.endsWith('youtube.com')) {
            const fromQuery = url.searchParams.get('v');
            if (fromQuery && /^[a-zA-Z0-9_-]{11}$/.test(fromQuery)) {
                return fromQuery;
            }

            const pathParts = (url.pathname || '').split('/').filter(Boolean);
            const shortsIndex = pathParts.indexOf('shorts');
            if (shortsIndex >= 0 && pathParts[shortsIndex + 1] && /^[a-zA-Z0-9_-]{11}$/.test(pathParts[shortsIndex + 1])) {
                return pathParts[shortsIndex + 1];
            }

            const embedIndex = pathParts.indexOf('embed');
            if (embedIndex >= 0 && pathParts[embedIndex + 1] && /^[a-zA-Z0-9_-]{11}$/.test(pathParts[embedIndex + 1])) {
                return pathParts[embedIndex + 1];
            }
        }
    } catch (error) {
        return null;
    }

    return null;
}

const YT_TITLE_CACHE = new Map(); // videoId -> title

async function fetchYouTubeTitle(videoId) {
    if (!videoId) return null;
    if (YT_TITLE_CACHE.has(videoId)) return YT_TITLE_CACHE.get(videoId);

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;

    try {
        const response = await fetch(endpoint, { method: 'GET' });
        if (!response.ok) return null;
        const data = await response.json();
        const title = sanitizeText(data?.title || '', 140);
        if (!title) return null;
        YT_TITLE_CACHE.set(videoId, title);
        return title;
    } catch (error) {
        return null;
    }
}

loadWords();

// ============== DATA STRUCTURES ==============

const lobbies = new Map();        // lobbyId -> Lobby
const players = new Map();        // playerId -> PlayerState
const socketToPlayer = new Map(); // socketId -> playerId
const playerToSocket = new Map(); // playerId -> socketId

// Player avatars pool
const AVATARS = ['🐱', '🐶', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵',
    '🦄', '🐲', '🦋', '🐙', '🦀', '🐬', '🦅', '🦉', '🐺', '🦈', '🐊', '🦖'];

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD',
    '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9', '#F8B500', '#00CED1'];

// ============== HELPER FUNCTIONS ==============

function generatePlayerId() {
    return 'player_' + uuidv4().substring(0, 8);
}

function generateLobbyCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function getRandomAvatar() {
    return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}

function getRandomColor() {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function stableHash(value = '') {
    let hash = 0;
    const input = String(value);
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function getStableGuestAvatar(playerId = '') {
    return AVATARS[stableHash(`avatar:${playerId}`) % AVATARS.length];
}

function getStableGuestColor(playerId = '') {
    return COLORS[stableHash(`color:${playerId}`) % COLORS.length];
}

function getRandomSyllable(difficultyLevel = 0) {
    if (SYLLABLES.length === 0) return 'ან';

    const pick = (pool) => pool[Math.floor(Math.random() * pool.length)];
    const roll = Math.random();

    // Progressively bias toward lower-frequency (harder) syllables.
    if (difficultyLevel < 2) {
        return pick(EASY_SYLLABLES);
    }

    if (difficultyLevel < 5) {
        return roll < 0.7 ? pick(EASY_SYLLABLES) : pick(MEDIUM_SYLLABLES);
    }

    if (difficultyLevel < 8) {
        if (roll < 0.2) return pick(EASY_SYLLABLES);
        return roll < 0.75 ? pick(MEDIUM_SYLLABLES) : pick(HARD_SYLLABLES);
    }

    return roll < 0.7 ? pick(HARD_SYLLABLES) : pick(MEDIUM_SYLLABLES);
}

function validateWord(word, syllable) {
    if (!word || word.length < 2) return false;
    const lowerWord = word.toLowerCase();
    const lowerSyl = syllable.toLowerCase();

    // Check if word contains syllable
    if (!lowerWord.includes(lowerSyl)) return false;

    // Check if word exists in dictionary
    return WORDS.some(w => w.toLowerCase() === lowerWord);
}

function broadcastLobbyList() {
    const lobbyList = Array.from(lobbies.values())
        .filter(l => l.settings.isPublic && l.state !== 'finished')
        .map(l => ({
            id: l.id,
            code: l.code,
            name: l.name,
            hostName: l.players.find(p => p.id === l.hostId)?.name || 'Unknown',
            playerCount: l.players.length,
            maxPlayers: l.settings.maxPlayers,
            state: l.state,
            language: 'Georgian'
        }));

    io.emit('lobby:list', lobbyList);
    console.log(`📢 Broadcasting lobby list: ${lobbyList.length} lobbies`);
}

function getLobbyList() {
    return Array.from(lobbies.values())
        .filter(l => l.settings.isPublic && l.state !== 'finished')
        .map(l => ({
            id: l.id,
            code: l.code,
            name: l.name,
            hostName: l.players.find(p => p.id === l.hostId)?.name || 'Unknown',
            playerCount: l.players.length,
            maxPlayers: l.settings.maxPlayers,
            state: l.state
        }));
}

// ============== LOBBY CLASS ==============

class Lobby {
    constructor(hostId, hostName, lobbyName, isPublic = true, initialMusicUrl = '') {
        this.id = uuidv4();
        this.code = generateLobbyCode();
        // Security: Sanitize lobby name using global function
        const safeLobbyName = sanitizeName(lobbyName, 30);
        const safeHostName = sanitizeName(hostName);
        this.name = safeLobbyName || `${safeHostName}'s Lobby`;
        this.hostId = hostId;
        this.originalHostId = hostId;
        this.players = [];
        this.state = 'waiting';
        this.settings = {
            maxPlayers: 8,
            startLives: 3,
            turnTime: 10,
            minWordLength: 2,
            rankedMode: false,
            isPublic: isPublic
        };

        this.currentTurnIndex = 0;
        this.currentSyllable = '';
        this.usedWords = new Set();
        this.timer = null;
        this.timerValue = 0;
        this.lastActivity = Date.now();
        this.turnStartTime = 0;
        this.turnLocked = false; // Prevent submissions after timeout
        this.turnsElapsed = 0;
        this.difficultyLevel = 0;
        this.currentTurnTime = this.settings.turnTime;
        this.currentMinWordLength = this.settings.minWordLength;
        this.currentGameId = null;
        this.gameStartedAt = 0;
        this.totalWordsThisGame = 0;
        this.musicTrackCounter = 0;
        this.musicProposalCounter = 0;
        this.music = {
            queue: [],
            proposals: [],
            currentTrackId: null
        };

        this.afkCheckInterval = null;
        this.startAfkChecker();

        if (initialMusicUrl) {
            this.addHostTrack(initialMusicUrl, hostId, hostName, true);
        }

        console.log(`🏠 Lobby created: ${this.code} (${this.name}) by ${hostName}`);
    }

    startAfkChecker() {
        this.afkCheckInterval = setInterval(() => {
            const now = Date.now();
            const inactiveTime = now - this.lastActivity;

            if (inactiveTime > 600000 && (this.players.length === 0 || this.state === 'waiting')) {
                this.destroy();
                lobbies.delete(this.id);
                broadcastLobbyList();
                console.log(`🗑️ Deleted inactive lobby: ${this.code}`);
            }

            if (this.state === 'playing') {
                const currentPlayer = this.players[this.currentTurnIndex];
                if (currentPlayer && !currentPlayer.isConnected) {
                    const disconnectTime = now - (currentPlayer.disconnectedAt || now);
                    if (disconnectTime > 5000) {
                        this.handleTimeout();
                    }
                }
            }
        }, 5000);
    }

    destroy() {
        if (this.timer) clearInterval(this.timer);
        if (this.afkCheckInterval) clearInterval(this.afkCheckInterval);
    }

    addPlayer(playerId, playerName, playerMeta = {}) {
        if (this.players.length >= this.settings.maxPlayers) return false;
        if (this.players.find(p => p.id === playerId)) return true; // Already in lobby

        // Security: Sanitize player name using global function
        const safeName = sanitizeName(playerName);
        const provider = playerMeta.provider || (String(playerId).startsWith('discord_') ? 'discord' : 'guest');

        const player = {
            id: playerId,
            name: safeName,
            avatar: provider === 'guest' ? getStableGuestAvatar(playerId) : getRandomAvatar(),
            avatarUrl: sanitizeText(playerMeta.avatarUrl || '', 500) || null,
            color: provider === 'guest' ? getStableGuestColor(playerId) : getRandomColor(),
            lives: this.settings.startLives,
            isConnected: true,
            isReady: false,
            currentInput: '',
            provider,
            username: sanitizeText(playerMeta.username || '', 40) || null,
            joinedAt: Date.now()
        };

        this.players.push(player);
        this.lastActivity = Date.now();

        if (playerId === this.originalHostId) {
            this.hostId = playerId;
        }

        console.log(`👤 ${playerName} joined lobby ${this.code} (${this.players.length} players)`);
        return true;
    }

    removePlayer(playerId) {
        const index = this.players.findIndex(p => p.id === playerId);
        if (index === -1) return;

        const playerName = this.players[index].name;
        this.players.splice(index, 1);
        this.lastActivity = Date.now();

        console.log(`👋 ${playerName} left lobby ${this.code} (${this.players.length} players)`);

        if (this.hostId === playerId && this.players.length > 0) {
            if (playerId !== this.originalHostId) {
                this.hostId = this.players[0].id;
                console.log(`👑 New host: ${this.players[0].name}`);
            }
        }

        if (this.state === 'playing') {
            if (index < this.currentTurnIndex) {
                this.currentTurnIndex--;
            } else if (index === this.currentTurnIndex) {
                this.currentTurnIndex = this.currentTurnIndex % Math.max(1, this.players.length);
            }

            if (this.getAlivePlayers().length <= 1) {
                this.endGame();
            }
        }
    }

    markDisconnected(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.isConnected = false;
            player.disconnectedAt = Date.now();
        }
    }

    markConnected(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.isConnected = true;
            player.disconnectedAt = null;
        }
    }

    getAlivePlayers() {
        return this.players.filter(p => p.lives > 0);
    }

    buildTrackTitle(videoId) {
        return `YouTube ${videoId}`;
    }

    updateTrackTitle(trackId, title) {
        if (!trackId || !title) return false;
        const cleanTitle = sanitizeText(title, 140);
        if (!cleanTitle) return false;

        const queueTrack = this.music.queue.find(track => track.id === trackId);
        if (queueTrack) {
            if (queueTrack.title === cleanTitle) return false;
            queueTrack.title = cleanTitle;
            return true;
        }

        const proposal = this.music.proposals.find(item => item?.track?.id === trackId);
        if (proposal?.track) {
            if (proposal.track.title === cleanTitle) return false;
            proposal.track.title = cleanTitle;
            return true;
        }

        return false;
    }

    refreshTrackTitleAsync(track) {
        if (!track?.videoId) return;
        fetchYouTubeTitle(track.videoId).then((resolvedTitle) => {
            if (!resolvedTitle) return;
            if (track.title === resolvedTitle) return;
            track.title = resolvedTitle;
            this.broadcastGameState();
        }).catch(() => { });
    }

    buildMusicTrack(url, submittedById, submittedByName) {
        const videoId = extractYouTubeVideoId(url);
        if (!videoId) return null;

        return {
            id: `trk_${++this.musicTrackCounter}`,
            videoId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            title: this.buildTrackTitle(videoId),
            submittedById,
            submittedByName: sanitizeName(submittedByName || 'Guest', 20),
            createdAt: Date.now()
        };
    }

    getCurrentTrack() {
        return this.music.queue.find(track => track.id === this.music.currentTrackId) || null;
    }

    addHostTrack(url, hostId, hostName, makeCurrent = false) {
        const track = this.buildMusicTrack(url, hostId, hostName);
        if (!track) return null;

        this.music.queue.push(track);
        if (!this.music.currentTrackId || makeCurrent) {
            this.music.currentTrackId = track.id;
        }
        this.refreshTrackTitleAsync(track);
        return track;
    }

    addMusicProposal(url, playerId, playerName) {
        const track = this.buildMusicTrack(url, playerId, playerName);
        if (!track) return null;

        const proposal = {
            id: `prop_${++this.musicProposalCounter}`,
            track
        };
        this.music.proposals.push(proposal);
        this.refreshTrackTitleAsync(track);
        return proposal;
    }

    approveMusicProposal(proposalId, makeCurrent = false) {
        const proposalIndex = this.music.proposals.findIndex(p => p.id === proposalId);
        if (proposalIndex === -1) return null;

        const [proposal] = this.music.proposals.splice(proposalIndex, 1);
        const track = {
            ...proposal.track,
            id: `trk_${++this.musicTrackCounter}`
        };
        this.music.queue.push(track);
        if (!this.music.currentTrackId || makeCurrent) {
            this.music.currentTrackId = track.id;
        }
        this.refreshTrackTitleAsync(track);
        return track;
    }

    rejectMusicProposal(proposalId) {
        const proposalIndex = this.music.proposals.findIndex(p => p.id === proposalId);
        if (proposalIndex === -1) return false;
        this.music.proposals.splice(proposalIndex, 1);
        return true;
    }

    setCurrentTrack(trackId) {
        const found = this.music.queue.find(track => track.id === trackId);
        if (!found) return false;
        this.music.currentTrackId = found.id;
        return true;
    }

    moveTrack(trackId, direction) {
        const idx = this.music.queue.findIndex(track => track.id === trackId);
        if (idx === -1) return false;
        const target = direction === 'up' ? idx - 1 : idx + 1;
        if (target < 0 || target >= this.music.queue.length) return false;
        const [item] = this.music.queue.splice(idx, 1);
        this.music.queue.splice(target, 0, item);
        return true;
    }

    removeTrack(trackId) {
        const idx = this.music.queue.findIndex(track => track.id === trackId);
        if (idx === -1) return false;
        const [removed] = this.music.queue.splice(idx, 1);
        if (removed.id === this.music.currentTrackId) {
            const fallback = this.music.queue[idx] || this.music.queue[idx - 1] || null;
            this.music.currentTrackId = fallback ? fallback.id : null;
        }
        return true;
    }

    playNextTrack() {
        if (this.music.queue.length === 0) {
            this.music.currentTrackId = null;
            return null;
        }

        if (!this.music.currentTrackId) {
            this.music.currentTrackId = this.music.queue[0].id;
            return this.music.queue[0];
        }

        const idx = this.music.queue.findIndex(track => track.id === this.music.currentTrackId);
        if (idx === -1) {
            this.music.currentTrackId = this.music.queue[0].id;
            return this.music.queue[0];
        }

        const nextIdx = (idx + 1) % this.music.queue.length;
        this.music.currentTrackId = this.music.queue[nextIdx].id;
        return this.music.queue[nextIdx];
    }

    updateDynamicDifficulty() {
        const turnsCompleted = Math.max(0, this.turnsElapsed - 1);
        // Ramp difficulty faster: one level every 5 turns.
        this.difficultyLevel = Math.min(14, Math.floor(turnsCompleted / 5));

        // Higher levels remove more time, with extra pressure in late game.
        const basePenalty = this.difficultyLevel * 0.7;
        const lateGamePenalty = this.difficultyLevel >= 8 ? (this.difficultyLevel - 7) * 0.12 : 0;
        const timePenalty = basePenalty + lateGamePenalty;
        this.currentTurnTime = Math.max(2.2, Number((this.settings.turnTime - timePenalty).toFixed(2)));

        // Increase minimum word length in late game.
        let minLengthBonus = 0;
        if (this.difficultyLevel >= 3) minLengthBonus = 1;
        if (this.difficultyLevel >= 6) minLengthBonus = 2;
        if (this.difficultyLevel >= 10) minLengthBonus = 3;
        this.currentMinWordLength = Math.min(6, this.settings.minWordLength + minLengthBonus);
    }

    startGame() {
        // Only include players who are ready AND connected
        const readyPlayers = this.players.filter(p => p.isReady && p.isConnected);

        if (readyPlayers.length < 2) return false;

        // Remove non-ready players from the game (they stay in lobby but won't play)
        this.players = readyPlayers;

        this.state = 'playing';
        this.usedWords.clear();
        this.currentTurnIndex = 0;
        this.turnsElapsed = 0;
        this.difficultyLevel = 0;
        this.currentTurnTime = this.settings.turnTime;
        this.currentMinWordLength = this.settings.minWordLength;
        this.currentGameId = uuidv4();
        this.gameStartedAt = Date.now();
        this.totalWordsThisGame = 0;

        this.players.forEach(p => {
            p.lives = this.settings.startLives;
            p.currentInput = '';
            p.score = 0; // Initialize score
            p.wordsCompleted = 0; // Track words completed
        });

        console.log(`🎮 Game started in lobby ${this.code} with ${this.players.length} ready players`);
        this.nextTurn();
        return true;
    }

    nextTurn() {
        // Unlock the turn for new submissions
        this.turnLocked = false;

        let checks = 0;
        while (this.players[this.currentTurnIndex]?.lives <= 0 && checks < this.players.length) {
            this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
            checks++;
        }

        this.turnsElapsed++;
        this.updateDynamicDifficulty();

        this.currentSyllable = getRandomSyllable(this.difficultyLevel);
        this.timerValue = this.currentTurnTime;
        this.turnStartTime = Date.now();
        this.lastActivity = Date.now();

        if (this.timer) clearInterval(this.timer);

        this.timer = setInterval(() => {
            this.timerValue -= 0.05;

            if (this.timerValue <= 0) {
                this.handleTimeout();
            } else {
                this.broadcastTimerUpdate();
            }
        }, 50);

        this.broadcastGameState();
    }

    handleTimeout() {
        if (this.timer) clearInterval(this.timer);

        // Lock the turn to prevent late submissions
        this.turnLocked = true;

        const loser = this.players[this.currentTurnIndex];
        if (!loser) return;

        loser.lives--;
        loser.currentInput = '';
        loser.streak = 0; // Reset streak on timeout

        console.log(`💥 ${loser.name} timed out! Lives: ${loser.lives}`);
        this.broadcastExplosion(loser.id);

        const alivePlayers = this.getAlivePlayers();

        setTimeout(() => {
            if (alivePlayers.length <= 1) {
                this.endGame();
            } else {
                this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
                this.nextTurn();
            }
        }, 1500);
    }

    submitWord(playerId, word) {
        if (this.state !== 'playing') return { success: false, reason: 'თამაში არ მიმდინარეობს' };

        // Prevent late submissions after timeout
        if (this.turnLocked) {
            return { success: false, reason: 'დაგვიანდა! დრო ამოიწურა' };
        }

        const currentPlayer = this.players[this.currentTurnIndex];
        if (!currentPlayer || currentPlayer.id !== playerId) {
            return { success: false, reason: 'შენი სვლა არ არის' };
        }

        // Security: Check if player is alive
        if (currentPlayer.lives <= 0) {
            return { success: false, reason: 'შენ გავარდი' };
        }

        // Security: Check if player is connected
        if (!currentPlayer.isConnected) {
            return { success: false, reason: 'მოთამაშე გავიდა' };
        }

        // Security: Validate word is a string
        if (typeof word !== 'string') {
            return { success: false, reason: 'არასწორი ტექსტი' };
        }

        const normalizedWord = sanitizeText(word, 50).toLowerCase();

        if (normalizedWord.length < this.currentMinWordLength) {
            return { success: false, reason: 'სიტყვა ძალიან მოკლეა' };
        }

        // Prevent typing just the syllable itself
        if (normalizedWord === this.currentSyllable.toLowerCase()) {
            return { success: false, reason: 'სიტყვა არ შეიძლება იყოს მხოლოდ მარცვალი!' };
        }

        // Word must be longer than the syllable
        if (normalizedWord.length <= this.currentSyllable.length) {
            return { success: false, reason: 'სიტყვა უნდა იყოს მარცვალზე გრძელი' };
        }

        if (this.usedWords.has(normalizedWord)) {
            return { success: false, reason: 'სიტყვა უკვე გამოყენებულია' };
        }

        if (!validateWord(normalizedWord, this.currentSyllable)) {
            return { success: false, reason: 'არასწორი სიტყვა ან არ შეიცავს მარცვალს' };
        }

        this.usedWords.add(normalizedWord);
        currentPlayer.currentInput = '';
        this.lastActivity = Date.now();

        if (this.timer) clearInterval(this.timer);

        // Calculate score based on word length and speed
        const timeRemaining = Math.max(0, this.timerValue);
        const wordLength = normalizedWord.length;

        // Track previous score for milestone check
        const previousScore = currentPlayer.score || 0;

        // Streak tracking
        currentPlayer.streak = (currentPlayer.streak || 0) + 1;
        const streakBonus = Math.min(50, (currentPlayer.streak - 1) * 10); // Up to +50 for 6+ streak

        // Score formula:
        // Base: 10 points per letter
        // Speed bonus: up to 50 points for fast answers (based on % time remaining)
        // Length bonus: extra 5 points per letter over 5
        // Streak bonus: +10 per consecutive answer (max +50)
        const baseScore = wordLength * 10;
        const speedBonus = Math.round((timeRemaining / this.currentTurnTime) * 50);
        const lengthBonus = Math.max(0, (wordLength - 5) * 5);
        const totalScore = baseScore + speedBonus + lengthBonus + streakBonus;

        currentPlayer.score = previousScore + totalScore;
        currentPlayer.wordsCompleted = (currentPlayer.wordsCompleted || 0) + 1;
        this.totalWordsThisGame += 1;

        // Check for bonus HP milestone (every 1000 points)
        const previousMilestone = Math.floor(previousScore / 1000);
        const newMilestone = Math.floor(currentPlayer.score / 1000);
        let bonusHP = 0;

        if (newMilestone > previousMilestone) {
            bonusHP = newMilestone - previousMilestone;
            currentPlayer.lives = Math.min(5, currentPlayer.lives + bonusHP); // Cap at 5 lives
            console.log(`💖 ${currentPlayer.name} earned ${bonusHP} bonus HP! (${currentPlayer.lives} lives)`);
        }

        // Special achievements disabled
        let special = null;

        console.log(`✓ ${currentPlayer.name} submitted: ${word} (+${totalScore} pts, total: ${currentPlayer.score})${bonusHP ? ` +${bonusHP}HP` : ''}${special ? ` ${special}` : ''}`);
        this.broadcastWordSuccess(playerId, word, totalScore, bonusHP, currentPlayer.streak, special);

        setTimeout(() => {
            this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
            this.nextTurn();
        }, 500);

        return { success: true };
    }

    updateTyping(playerId, text) {
        // Security: Validate game state
        if (this.state !== 'playing') return;

        // Prevent typing after timeout
        if (this.turnLocked) return;

        // Security: Validate it's this player's turn
        const currentPlayer = this.players[this.currentTurnIndex];
        if (!currentPlayer || currentPlayer.id !== playerId) return;

        // Security: Validate player is alive
        if (currentPlayer.lives <= 0) return;

        // Security: Validate player is connected
        if (!currentPlayer.isConnected) return;

        // Security: Sanitize text - strip HTML/scripts, limit length
        const sanitizedText = sanitizeText(text, 50);

        currentPlayer.currentInput = sanitizedText;
        this.lastActivity = Date.now();
        this.broadcastTyping(playerId, sanitizedText);
    }


    async endGame() {
        if (this.timer) clearInterval(this.timer);

        this.state = 'finished';

        // Sort all players by score (highest first), then by lives remaining
        const rankings = [...this.players]
            .sort((a, b) => {
                // First by score
                if (b.score !== a.score) return (b.score || 0) - (a.score || 0);
                // Then by lives remaining
                return b.lives - a.lives;
            })
            .map((p, index) => ({
                rank: index + 1,
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                avatarUrl: p.avatarUrl || null,
                username: p.username || null,
                provider: p.provider || (String(p.id).startsWith('discord_') ? 'discord' : 'guest'),
                color: p.color,
                score: p.score || 0,
                wordsCompleted: p.wordsCompleted || 0,
                lives: p.lives
            }));

        const winner = rankings[0];
        const gameDurationSeconds = Math.max(1, Math.round((Date.now() - this.gameStartedAt) / 1000));
        const rankedResult = await this.processRankedAndStats(rankings, winner, gameDurationSeconds);

        console.log(`🏆 Game ended in ${this.code}. Winner: ${winner?.name || 'Nobody'} with ${winner?.score || 0} pts`);
        this.broadcastGameEnd(winner, rankings, rankedResult);

        setTimeout(() => {
            this.state = 'waiting';
            this.turnsElapsed = 0;
            this.difficultyLevel = 0;
            this.currentTurnTime = this.settings.turnTime;
            this.currentMinWordLength = this.settings.minWordLength;
            this.players.forEach(p => {
                p.isReady = false;
                p.lives = this.settings.startLives;
                p.score = 0;
                p.wordsCompleted = 0;
                p.streak = 0;
            });
            this.currentGameId = null;
            this.gameStartedAt = 0;
            this.totalWordsThisGame = 0;
            this.broadcastGameState();
            broadcastLobbyList();
        }, 5000);
    }

    async processRankedAndStats(rankings, winner, gameDurationSeconds) {
        const playerEntries = rankings.map(p => ({ id: p.id, name: p.name }));
        const existingProfiles = await getProfilesByIds(playerEntries);
        const playerCount = Math.max(2, rankings.length);
        const allDiscordPlayers = rankings.every(p => String(p.id || '').startsWith('discord_'));
        const isRanked = Boolean(this.settings.rankedMode && allDiscordPlayers);
        const kFactor = RANKED_K_FACTOR;
        const mmrChanges = [];
        const profileUpdates = [];

        rankings.forEach((rankedPlayer) => {
            const base = existingProfiles.get(rankedPlayer.id) || createDefaultProfile(rankedPlayer.id, rankedPlayer.name);
            const profile = normalizeProfileRow(base, rankedPlayer.name);
            const rank = rankedPlayer.rank || playerCount;
            const actualScore = playerCount > 1 ? (playerCount - rank) / (playerCount - 1) : 1;

            let avgOppMmr = profile.mmr;
            if (rankings.length > 1) {
                const opponents = rankings
                    .filter(p => p.id !== rankedPlayer.id)
                    .map(p => normalizeProfileRow(existingProfiles.get(p.id) || createDefaultProfile(p.id, p.name), p.name));
                const totalOpp = opponents.reduce((sum, opp) => sum + opp.mmr, 0);
                avgOppMmr = totalOpp / opponents.length;
            }

            const expectedScore = 1 / (1 + Math.pow(10, (avgOppMmr - profile.mmr) / 400));
            const rawDelta = Math.round(kFactor * (actualScore - expectedScore));
            const mmrDelta = isRanked ? Math.max(-RANKED_DELTA_CAP, Math.min(RANKED_DELTA_CAP, rawDelta)) : 0;
            const previousMmr = profile.mmr;
            const nextMmr = previousMmr + mmrDelta;

            profile.display_name = rankedPlayer.name || profile.display_name;
            profile.games_played += 1;
            profile.total_guessed_words += rankedPlayer.wordsCompleted || 0;
            profile.best_game_words = Math.max(profile.best_game_words, rankedPlayer.wordsCompleted || 0);
            profile.longest_game_seconds = Math.max(profile.longest_game_seconds, gameDurationSeconds);
            profile.total_game_seconds += gameDurationSeconds;
            profile.total_score += rankedPlayer.score || 0;

            if (isRanked) {
                profile.ranked_games += 1;
                if (winner && rankedPlayer.id === winner.id) profile.wins += 1;
                else profile.losses += 1;
                profile.mmr = nextMmr;
                profile.highest_mmr = Math.max(profile.highest_mmr, profile.mmr);
            }
            profile.updated_at = new Date().toISOString();

            mmrChanges.push({
                id: rankedPlayer.id,
                name: rankedPlayer.name,
                previousMmr,
                mmr: profile.mmr,
                delta: mmrDelta,
                rankLabel: calculateRankMmrLabel(profile.mmr)
            });
            profileUpdates.push(profile);
        });

        await upsertProfiles(profileUpdates);

        const matchRow = {
            id: this.currentGameId || uuidv4(),
            lobby_code: this.code,
            is_ranked: isRanked,
            started_at: new Date(Date.now() - (gameDurationSeconds * 1000)).toISOString(),
            ended_at: new Date().toISOString(),
            turns_elapsed: this.turnsElapsed,
            total_words: this.totalWordsThisGame,
            duration_seconds: gameDurationSeconds,
            winner_player_id: winner?.id || null,
            participant_ids: rankings.map(p => p.id),
            rankings
        };
        await insertRankedMatch(matchRow);

        return {
            gameId: matchRow.id,
            isRanked,
            mmrChanges
        };
    }

    broadcastGameState() {
        const currentTrack = this.getCurrentTrack();
        io.to(this.id).emit('game:state', {
            state: this.state,
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                avatarUrl: p.avatarUrl || null,
                username: p.username || null,
                provider: p.provider || (String(p.id).startsWith('discord_') ? 'discord' : 'guest'),
                color: p.color,
                lives: p.lives,
                score: p.score || 0,
                wordsCompleted: p.wordsCompleted || 0,
                streak: p.streak || 0,
                isConnected: p.isConnected,
                isReady: p.isReady,
                currentInput: p.currentInput
            })),
            hostId: this.hostId,
            currentTurnIndex: this.currentTurnIndex,
            currentSyllable: this.currentSyllable,
            timerValue: this.timerValue,
            timerMax: this.currentTurnTime,
            difficulty: {
                level: this.difficultyLevel,
                turnsElapsed: this.turnsElapsed,
                minWordLength: this.currentMinWordLength
            },
            settings: this.settings,
            music: {
                currentTrack: currentTrack ? { ...currentTrack } : null,
                queue: this.music.queue.map(track => ({ ...track })),
                proposals: this.music.proposals.map(proposal => ({
                    id: proposal.id,
                    track: { ...proposal.track }
                }))
            }
        });
    }

    broadcastTimerUpdate() {
        io.to(this.id).emit('game:timer', {
            timerValue: this.timerValue,
            timerMax: this.currentTurnTime
        });
    }

    broadcastTyping(playerId, text) {
        io.to(this.id).emit('game:typing', { playerId, text });
    }

    broadcastExplosion(playerId) {
        io.to(this.id).emit('game:explosion', {
            playerId,
            players: this.players.map(p => ({
                id: p.id,
                lives: p.lives
            }))
        });
    }

    broadcastWordSuccess(playerId, word, score, bonusHP = 0, streak = 1, special = null) {
        io.to(this.id).emit('game:word-success', {
            playerId,
            word,
            score,
            bonusHP,
            streak,
            special,
            // Include updated player data
            playerLives: this.players.find(p => p.id === playerId)?.lives || 0
        });
    }

    broadcastGameEnd(winner, rankings, rankedResult = null) {
        io.to(this.id).emit('game:end', {
            winner: winner ? {
                id: winner.id,
                name: winner.name,
                avatar: winner.avatar,
                avatarUrl: winner.avatarUrl || null,
                username: winner.username || null,
                score: winner.score || 0
            } : null,
            rankings: rankings || [],
            ranked: rankedResult || {
                gameId: this.currentGameId || null,
                isRanked: Boolean(this.settings.rankedMode),
                mmrChanges: []
            }
        });
    }
}

function getLocalLeaderboard(metric = 'mmr', limit = 50) {
    const allProfiles = Array.from(LOCAL_PROFILE_STORE.values());
    const metricOrder = {
        mmr: ['mmr', 'highest_mmr', 'total_guessed_words'],
        words: ['total_guessed_words', 'mmr', 'wins'],
        longest_game: ['longest_game_seconds', 'mmr', 'total_guessed_words'],
        best_game_words: ['best_game_words', 'mmr', 'total_guessed_words']
    };
    const keys = metricOrder[metric] || metricOrder.mmr;

    return allProfiles
        .sort((a, b) => {
            for (const key of keys) {
                if ((b[key] || 0) !== (a[key] || 0)) return (b[key] || 0) - (a[key] || 0);
            }
            return 0;
        })
        .slice(0, limit)
        .map((p, i) => ({
            rank: i + 1,
            ...withPlayerVisuals(p),
            rank_label: calculateRankMmrLabel(p.mmr || DEFAULT_MMR)
        }));
}

async function getLeaderboard(metric = 'mmr', limit = 50) {
    if (!isSupabaseConfigured()) {
        return getLocalLeaderboard(metric, limit);
    }

    const metricMap = {
        mmr: 'mmr.desc,highest_mmr.desc,total_guessed_words.desc',
        words: 'total_guessed_words.desc,mmr.desc,wins.desc',
        longest_game: 'longest_game_seconds.desc,mmr.desc,total_guessed_words.desc',
        best_game_words: 'best_game_words.desc,mmr.desc,total_guessed_words.desc'
    };
    const order = metricMap[metric] || metricMap.mmr;

    try {
        const rows = await supabaseRequest('GET', 'player_profiles', {
            query: `select=*&order=${order}&limit=${Math.max(1, Math.min(200, limit))}`
        });

        return rows.map((row, i) => ({
            rank: i + 1,
            ...withPlayerVisuals(normalizeProfileRow(row, row.display_name)),
            rank_label: calculateRankMmrLabel(Number(row.mmr ?? DEFAULT_MMR))
        }));
    } catch (error) {
        console.error('Leaderboard fetch failed, using local store:', error.message);
        return getLocalLeaderboard(metric, limit);
    }
}

async function getProfileWithMatches(playerId) {
    const localProfile = LOCAL_PROFILE_STORE.get(playerId) || createDefaultProfile(playerId, 'Player');
    let profile = normalizeProfileRow(localProfile, localProfile.display_name);
    let matches = LOCAL_MATCH_STORE
        .filter(m => Array.isArray(m.participant_ids) && m.participant_ids.includes(playerId))
        .slice(0, 10);

    if (!isSupabaseConfigured()) {
        return { profile, matches };
    }

    try {
        const rows = await supabaseRequest('GET', 'player_profiles', {
            query: `select=*&id=eq.${encodeURIComponent(playerId)}&limit=1`
        });
        if (rows.length > 0) {
            profile = normalizeProfileRow(rows[0], rows[0].display_name);
            LOCAL_PROFILE_STORE.set(playerId, profile);
        }
    } catch (error) {
        console.error('Profile fetch failed:', error.message);
    }

    try {
        const recent = await supabaseRequest('GET', 'ranked_matches', {
            query: `select=id,lobby_code,is_ranked,started_at,ended_at,total_words,duration_seconds,winner_player_id,rankings,participant_ids&participant_ids=cs.{${encodeURIComponent(playerId)}}&order=ended_at.desc&limit=10`
        });
        if (Array.isArray(recent)) matches = recent;
    } catch (error) {
        console.error('Recent matches fetch failed:', error.message);
    }

    return { profile: withPlayerVisuals(profile), matches };
}

// ============== AUTH REST API ==============
app.get('/api/auth/me', async (req, res) => {
    const user = await getAuthUserFromRequest(req);
    res.json({
        ok: true,
        authenticated: Boolean(user),
        provider: user?.provider || 'guest',
        user: user || null
    });
});

app.post('/api/auth/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const sid = cookies.bp_session;
    if (sid) authSessions.delete(sid);
    clearSessionCookie(res);
    res.json({ ok: true });
});

// ============== RANKED REST API ==============
app.get('/api/ranked/config', (req, res) => {
    res.json({
        configured: isSupabaseConfigured(),
        source: runtimeSupabaseConfig.url ? 'runtime' : (SUPABASE_URL_ENV ? 'env' : 'none'),
        mmr: {
            base: DEFAULT_MMR,
            kFactor: RANKED_K_FACTOR,
            maxDelta: RANKED_DELTA_CAP
        }
    });
});

app.post('/api/ranked/config', (req, res) => {
    const { url, anonKey } = req.body || {};
    if (!url || !anonKey) {
        return res.status(400).json({ ok: false, error: 'Missing url or anonKey' });
    }
    setSupabaseRuntimeConfig(url, anonKey);
    res.json({ ok: true, configured: isSupabaseConfigured() });
});

app.post('/api/ranked/register', async (req, res) => {
    const authUser = await getAuthUserFromRequest(req);
    const requestedPlayerId = sanitizeText(req.body?.playerId || '', 64);
    let playerId = requestedPlayerId;
    let playerName = sanitizeName(req.body?.playerName || 'Player', 20);

    if (authUser?.provider === 'discord') {
        playerId = authUser.id;
        playerName = sanitizeName(authUser.displayName || authUser.username || playerName, 20);
        cachePlayerVisual(playerId, { username: authUser.username, avatarUrl: authUser.avatar });
    }

    if (!authUser && String(playerId || '').startsWith('discord_')) {
        return res.status(401).json({ ok: false, error: 'Discord auth required for discord profiles' });
    }

    if (!playerId) {
        return res.status(400).json({ ok: false, error: 'playerId is required' });
    }

    const existing = await getProfilesByIds([{ id: playerId, name: playerName }]);
    const profile = normalizeProfileRow(existing.get(playerId) || createDefaultProfile(playerId, playerName), playerName);
    profile.display_name = playerName;
    profile.updated_at = new Date().toISOString();
    await upsertProfiles([profile]);

    res.json({
        ok: true,
        profile: {
            ...profile,
            rank_label: calculateRankMmrLabel(profile.mmr)
        }
    });
});

app.get('/api/ranked/leaderboard', async (req, res) => {
    const metric = sanitizeText(req.query.metric || 'mmr', 30);
    const limit = Number(req.query.limit || 50);
    const leaderboard = await getLeaderboard(metric, limit);
    res.json({
        ok: true,
        metric,
        leaderboard
    });
});

app.get('/api/ranked/profile/:playerId', async (req, res) => {
    const authUser = await getAuthUserFromRequest(req);
    let playerId = sanitizeText(req.params.playerId || '', 64);
    if (playerId === 'me' && authUser?.provider === 'discord') {
        playerId = authUser.id;
    }
    if (!playerId) return res.status(400).json({ ok: false, error: 'Invalid playerId' });

    if (!authUser && String(playerId || '').startsWith('discord_')) {
        return res.status(401).json({ ok: false, error: 'Discord auth required for discord profile' });
    }

    const { profile, matches } = await getProfileWithMatches(playerId);
    res.json({
        ok: true,
        profile: {
            ...profile,
            rank_label: calculateRankMmrLabel(profile.mmr)
        },
        matches
    });
});

// ============== SOCKET HANDLERS ==============

io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);

    socket.data.authUser = null;
    const refreshSocketAuth = async (authToken = '') => {
        if (!authToken) {
            socket.data.authUser = null;
            return null;
        }
        try {
            const verified = await verifySupabaseAccessToken(authToken);
            socket.data.authUser = verified || null;
            return socket.data.authUser;
        } catch (error) {
            console.error('Socket auth verify failed:', error.message);
            socket.data.authUser = null;
            return null;
        }
    };

    // Send lobby list immediately
    socket.emit('lobby:list', getLobbyList());

    const ensureSocketPlayer = (fallbackName = 'Guest') => {
        const mappedPlayerId = socketToPlayer.get(socket.id);
        if (mappedPlayerId && players.has(mappedPlayerId)) {
            return mappedPlayerId;
        }

        if (socket.data.authUser?.provider === 'discord') {
            const authUser = socket.data.authUser;
            const pid = authUser.id;
            const existing = players.get(pid);
            if (existing) {
                existing.socketId = socket.id;
                existing.name = authUser.displayName || existing.name;
                existing.provider = 'discord';
                existing.discordId = authUser.discordId;
                existing.username = authUser.username || existing.username || null;
                existing.avatarUrl = authUser.avatar || existing.avatarUrl || null;
            } else {
                players.set(pid, {
                    id: pid,
                    name: authUser.displayName || fallbackName,
                    socketId: socket.id,
                    currentLobbyId: null,
                    provider: 'discord',
                    discordId: authUser.discordId,
                    username: authUser.username || null,
                    avatarUrl: authUser.avatar || null
                });
            }
            cachePlayerVisual(pid, { username: authUser.username, avatarUrl: authUser.avatar });
            socketToPlayer.set(socket.id, pid);
            playerToSocket.set(pid, socket.id);
            return pid;
        }

        const guestId = generatePlayerId();
        players.set(guestId, {
            id: guestId,
            name: fallbackName || 'Guest',
            socketId: socket.id,
            currentLobbyId: null,
            provider: 'guest',
            username: null,
            avatarUrl: null
        });
        socketToPlayer.set(socket.id, guestId);
        playerToSocket.set(guestId, socket.id);
        return guestId;
    };

    const syncLobbyPlayerMetadata = (player) => {
        if (!player?.currentLobbyId) return;
        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;
        const lobbyPlayer = lobby.players.find(p => p.id === player.id);
        if (!lobbyPlayer) return;
        lobbyPlayer.name = player.name || lobbyPlayer.name;
        lobbyPlayer.provider = player.provider || lobbyPlayer.provider || 'guest';
        lobbyPlayer.username = player.username || null;
        lobbyPlayer.avatarUrl = player.avatarUrl || null;
        cachePlayerVisual(player.id, { username: lobbyPlayer.username, avatarUrl: lobbyPlayer.avatarUrl });
    };

    // ========== PLAYER AUTH ==========
    socket.on('player:auth', async ({ playerId, playerName, authToken }) => {
        console.log(`🔑 Auth request: ${playerName} (${playerId || 'new'})`);
        await refreshSocketAuth(sanitizeText(authToken || '', 4096));

        let pid = playerId;
        let isReconnect = false;
        let resolvedName = playerName || 'Player';

        if (socket.data.authUser?.provider === 'discord') {
            pid = socket.data.authUser.id;
            resolvedName = socket.data.authUser.displayName || resolvedName;
        }

        // Check if reconnecting with existing ID
        if (pid && players.has(pid)) {
            isReconnect = true;
            const oldSocketId = playerToSocket.get(pid);
            if (oldSocketId && oldSocketId !== socket.id) {
                socketToPlayer.delete(oldSocketId);
            }
            // Update player data
            const existingPlayer = players.get(pid);
            existingPlayer.name = resolvedName || existingPlayer.name;
            existingPlayer.socketId = socket.id;
            existingPlayer.provider = socket.data.authUser?.provider || existingPlayer.provider || 'guest';
            if (socket.data.authUser?.discordId) existingPlayer.discordId = socket.data.authUser.discordId;
            existingPlayer.username = socket.data.authUser?.username || existingPlayer.username || null;
            existingPlayer.avatarUrl = socket.data.authUser?.avatar || existingPlayer.avatarUrl || null;
        } else {
            pid = socket.data.authUser?.provider === 'discord' ? socket.data.authUser.id : generatePlayerId();
            players.set(pid, {
                id: pid,
                name: resolvedName || 'Player',
                socketId: socket.id,
                currentLobbyId: null,
                provider: socket.data.authUser?.provider || 'guest',
                discordId: socket.data.authUser?.discordId || null,
                username: socket.data.authUser?.username || null,
                avatarUrl: socket.data.authUser?.avatar || null
            });
        }

        socketToPlayer.set(socket.id, pid);
        playerToSocket.set(pid, socket.id);
        syncLobbyPlayerMetadata(players.get(pid));
        cachePlayerVisual(pid, {
            username: players.get(pid)?.username || socket.data.authUser?.username,
            avatarUrl: players.get(pid)?.avatarUrl || socket.data.authUser?.avatar
        });

        socket.emit('player:authed', {
            playerId: pid,
            playerName: resolvedName || 'Player',
            isReconnect,
            provider: socket.data.authUser?.provider || 'guest',
            isDiscord: socket.data.authUser?.provider === 'discord',
            username: socket.data.authUser?.username || null,
            avatarUrl: socket.data.authUser?.avatar || null
        });

        console.log(`✅ Authed: ${playerName} -> ${pid} (reconnect: ${isReconnect})`);

        // If reconnecting to a lobby, rejoin the room
        const player = players.get(pid);
        if (player && player.currentLobbyId) {
            const lobby = lobbies.get(player.currentLobbyId);
            if (lobby) {
                socket.join(lobby.id);
                lobby.markConnected(pid);
                lobby.broadcastGameState();
            }
        }
    });

    // ========== SESSION RESTORE ==========
    socket.on('player:restore', async ({ playerId, playerName, lobbyId, lobbyCode, authToken }) => {
        console.log(`🔄 Restore request: ${playerName} (${playerId}) -> lobby ${lobbyCode || lobbyId}`);
        await refreshSocketAuth(sanitizeText(authToken || '', 4096));

        let pid = playerId;
        let resolvedName = playerName || 'Guest';
        let lobby = null;

        if (socket.data.authUser?.provider === 'discord') {
            pid = socket.data.authUser.id;
            resolvedName = socket.data.authUser.displayName || resolvedName;
        }

        // Try to find the lobby
        if (lobbyId) {
            lobby = lobbies.get(lobbyId);
        }
        if (!lobby && lobbyCode) {
            lobby = Array.from(lobbies.values()).find(l => l.code === lobbyCode);
        }

        // Check if player exists and was in this lobby
        if (pid && players.has(pid)) {
            const existingPlayer = players.get(pid);
            const oldSocketId = playerToSocket.get(pid);
            if (oldSocketId && oldSocketId !== socket.id) {
                socketToPlayer.delete(oldSocketId);
            }
            existingPlayer.socketId = socket.id;
            existingPlayer.name = resolvedName || existingPlayer.name;
            existingPlayer.provider = socket.data.authUser?.provider || existingPlayer.provider || 'guest';
            if (socket.data.authUser?.discordId) existingPlayer.discordId = socket.data.authUser.discordId;
            existingPlayer.username = socket.data.authUser?.username || existingPlayer.username || null;
            existingPlayer.avatarUrl = socket.data.authUser?.avatar || existingPlayer.avatarUrl || null;

            socketToPlayer.set(socket.id, pid);
            playerToSocket.set(pid, socket.id);
            syncLobbyPlayerMetadata(existingPlayer);
            cachePlayerVisual(pid, { username: existingPlayer.username, avatarUrl: existingPlayer.avatarUrl });

            // Check if they were in the lobby
            if (lobby) {
                const lobbyPlayer = lobby.players.find(p => p.id === pid);
                if (lobbyPlayer) {
                    // Restore them to the lobby
                    socket.join(lobby.id);
                    existingPlayer.currentLobbyId = lobby.id;
                    lobby.markConnected(pid);

                    socket.emit('player:restored', {
                        playerId: pid,
                        playerName: existingPlayer.name,
                        provider: existingPlayer.provider || (String(pid).startsWith('discord_') ? 'discord' : 'guest'),
                        username: existingPlayer.username || null,
                        avatarUrl: existingPlayer.avatarUrl || null,
                        inLobby: true,
                        lobbyId: lobby.id,
                        lobbyCode: lobby.code,
                        lobbyName: lobby.name
                    });

                    lobby.broadcastGameState();
                    console.log(`✅ Restored ${playerName} to lobby ${lobby.code}`);
                    return;
                }
            }

            // Player exists but not in requested lobby
            socket.emit('player:restored', {
                playerId: pid,
                playerName: existingPlayer.name,
                provider: existingPlayer.provider || (String(pid).startsWith('discord_') ? 'discord' : 'guest'),
                username: existingPlayer.username || null,
                avatarUrl: existingPlayer.avatarUrl || null,
                inLobby: false
            });
            console.log(`✅ Restored ${playerName} (not in lobby)`);
        } else {
            // Create new player
            pid = socket.data.authUser?.provider === 'discord' ? socket.data.authUser.id : generatePlayerId();
            players.set(pid, {
                id: pid,
                name: resolvedName || 'Guest',
                socketId: socket.id,
                currentLobbyId: null,
                provider: socket.data.authUser?.provider || 'guest',
                discordId: socket.data.authUser?.discordId || null,
                username: socket.data.authUser?.username || null,
                avatarUrl: socket.data.authUser?.avatar || null
            });
            socketToPlayer.set(socket.id, pid);
            playerToSocket.set(pid, socket.id);
            cachePlayerVisual(pid, {
                username: socket.data.authUser?.username || null,
                avatarUrl: socket.data.authUser?.avatar || null
            });

            socket.emit('player:restore-failed', {
                reason: 'Session expired',
                newPlayerId: pid
            });
            socket.emit('player:authed', {
                playerId: pid,
                playerName: resolvedName || 'Guest',
                provider: socket.data.authUser?.provider || 'guest',
                isDiscord: socket.data.authUser?.provider === 'discord',
                username: socket.data.authUser?.username || null,
                avatarUrl: socket.data.authUser?.avatar || null
            });
            console.log(`❌ Restore failed, created new player: ${pid}`);
        }
    });

    // ========== LOBBY MANAGEMENT ==========
    socket.on('lobby:create', ({ playerName, lobbyName, isPublic, musicUrl }) => {
        // Security: Rate limit lobby creation (max 3 per 10 seconds)
        if (isRateLimited(socket.id, 'lobby:create', 3, 10000)) {
            socket.emit('error', { message: 'ძალიან ბევრი მოთხოვნაა. გთხოვთ დაიცადოთ.' });
            return;
        }

        // Auto-create player if not exists (guest mode or discord session)
        let playerId = socketToPlayer.get(socket.id);

        if (!playerId) {
            playerId = ensureSocketPlayer(playerName || 'Guest');
            socket.emit('player:authed', {
                playerId,
                playerName: socket.data.authUser?.provider === 'discord'
                    ? (socket.data.authUser.displayName || playerName || 'Guest')
                    : (playerName || 'Guest'),
                provider: socket.data.authUser?.provider || 'guest',
                isDiscord: socket.data.authUser?.provider === 'discord',
                username: socket.data.authUser?.username || null,
                avatarUrl: socket.data.authUser?.avatar || null
            });
            console.log(`👤 Auto-created player: ${playerName} (${playerId})`);
        }

        const player = players.get(playerId);
        if (player.provider !== 'discord') {
            player.name = playerName || player.name || 'Guest';
        }

        console.log(`📝 Create lobby request from ${player.name}: ${lobbyName}`);

        // Leave current lobby if in one
        if (player.currentLobbyId) {
            const oldLobby = lobbies.get(player.currentLobbyId);
            if (oldLobby) {
                oldLobby.removePlayer(playerId);
                socket.leave(oldLobby.id);
                if (oldLobby.players.length === 0) {
                    oldLobby.destroy();
                    lobbies.delete(oldLobby.id);
                }
            }
        }

        const lobby = new Lobby(playerId, player.name, lobbyName, isPublic !== false, musicUrl || '');
        lobby.addPlayer(playerId, player.name, player);
        lobbies.set(lobby.id, lobby);

        socket.join(lobby.id);
        player.currentLobbyId = lobby.id;

        socket.emit('lobby:joined', {
            lobbyId: lobby.id,
            lobbyCode: lobby.code,
            lobbyName: lobby.name
        });

        lobby.broadcastGameState();
        broadcastLobbyList();

        console.log(`✅ Lobby created: ${lobby.code}`);
    });

    socket.on('lobby:join', ({ lobbyCode, playerName }) => {
        // Security: Rate limit lobby joins (max 5 per 10 seconds)
        if (isRateLimited(socket.id, 'lobby:join', 5, 10000)) {
            socket.emit('error', { message: 'ძალიან ბევრი მოთხოვნაა. გთხოვთ დაიცადოთ.' });
            return;
        }

        // Security: Validate lobbyCode
        if (!lobbyCode || typeof lobbyCode !== 'string') {
            socket.emit('error', { message: 'ლობის კოდი არასწორია' });
            return;
        }

        // Security: Sanitize player name
        const safeName = sanitizeName(playerName);

        // Auto-create player if not exists (guest mode or discord session)
        let playerId = socketToPlayer.get(socket.id);

        if (!playerId) {
            playerId = ensureSocketPlayer(safeName);
            socket.emit('player:authed', {
                playerId,
                playerName: socket.data.authUser?.provider === 'discord'
                    ? (socket.data.authUser.displayName || safeName || 'Guest')
                    : safeName,
                provider: socket.data.authUser?.provider || 'guest',
                isDiscord: socket.data.authUser?.provider === 'discord',
                username: socket.data.authUser?.username || null,
                avatarUrl: socket.data.authUser?.avatar || null
            });
            console.log(`👤 Auto-created player: ${safeName} (${playerId})`);
        }

        const player = players.get(playerId);
        if (player.provider !== 'discord') {
            player.name = safeName || player.name || 'Guest';
        }

        console.log(`📥 Join lobby request: ${lobbyCode} from ${player.name} (${playerId})`);

        const lobby = Array.from(lobbies.values()).find(l => l.code === lobbyCode.toUpperCase());

        if (!lobby) {
            console.log(`❌ Lobby not found: ${lobbyCode}`);
            socket.emit('error', { message: 'ლობი არ მოიძებნა' });
            return;
        }

        // Leave current lobby if in a different one
        if (player.currentLobbyId && player.currentLobbyId !== lobby.id) {
            const oldLobby = lobbies.get(player.currentLobbyId);
            if (oldLobby) {
                oldLobby.removePlayer(playerId);
                socket.leave(oldLobby.id);
                if (oldLobby.players.length === 0) {
                    oldLobby.destroy();
                    lobbies.delete(oldLobby.id);
                }
            }
        }

        if (lobby.state === 'playing') {
            // Check if player was in this game (by ID or by name for reconnection)
            let existingPlayer = lobby.players.find(p => p.id === playerId);

            // Also try to find by name if they have a disconnected player with same name
            if (!existingPlayer) {
                existingPlayer = lobby.players.find(p =>
                    p.name === player.name && !p.isConnected
                );
                if (existingPlayer) {
                    // Update the player ID mapping
                    console.log(`🔄 Reconnecting ${player.name} to their old slot`);
                    existingPlayer.id = playerId;
                }
            }

            if (!existingPlayer) {
                socket.emit('error', { message: 'თამაში მიმდინარეობს - შესვლა შეუძლებელია' });
                return;
            }

            existingPlayer.isConnected = true;
            existingPlayer.disconnectedAt = null;
        } else {
            // Check if already in lobby
            const existingPlayer = lobby.players.find(p => p.id === playerId);
            if (existingPlayer) {
                existingPlayer.isConnected = true;
            } else {
                if (!lobby.addPlayer(playerId, player.name, player)) {
                    socket.emit('error', { message: 'ვერ შევდივარ (სავსეა?)' });
                    return;
                }
            }
        }

        socket.join(lobby.id);
        player.currentLobbyId = lobby.id;

        socket.emit('lobby:joined', {
            lobbyId: lobby.id,
            lobbyCode: lobby.code,
            lobbyName: lobby.name
        });

        lobby.broadcastGameState();
        broadcastLobbyList();

        console.log(`✅ Joined lobby: ${lobby.code}`);
    });

    socket.on('lobby:leave', () => {
        handleLeaveLobby(socket);
    });

    socket.on('lobby:refresh', () => {
        socket.emit('lobby:list', getLobbyList());
    });

    // ========== LOBBY SETTINGS ==========
    socket.on('lobby:settings', (settings) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;

        if (settings.maxPlayers) lobby.settings.maxPlayers = Math.min(12, Math.max(2, settings.maxPlayers));
        if (settings.startLives) lobby.settings.startLives = Math.min(5, Math.max(1, settings.startLives));
        if (settings.turnTime) lobby.settings.turnTime = Math.min(30, Math.max(5, settings.turnTime));
        if (settings.minWordLength) lobby.settings.minWordLength = Math.min(5, Math.max(2, settings.minWordLength));
        if (typeof settings.rankedMode === 'boolean') {
            const hostIsDiscord = String(playerId || '').startsWith('discord_');
            if (settings.rankedMode && !hostIsDiscord) {
                socket.emit('error', { message: 'Ranked რეჟიმი ხელმისაწვდომია მხოლოდ Discord ავტორიზაციით' });
            } else {
                lobby.settings.rankedMode = settings.rankedMode;
            }
        }
        if (typeof settings.isPublic === 'boolean') lobby.settings.isPublic = settings.isPublic;

        if (lobby.state !== 'playing') {
            lobby.currentTurnTime = lobby.settings.turnTime;
            lobby.currentMinWordLength = lobby.settings.minWordLength;
        }

        lobby.broadcastGameState();
        broadcastLobbyList();
    });

    // ========== MUSIC CONTROL ==========
    socket.on('music:host-add', ({ url, playNow }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;

        if (isRateLimited(socket.id, 'music:host-add', 5, 10000)) {
            socket.emit('error', { message: 'Too many music requests. Please wait a bit.' });
            return;
        }

        const track = lobby.addHostTrack(url, playerId, player.name, Boolean(playNow));
        if (!track) {
            socket.emit('error', { message: 'Please paste a valid YouTube link.' });
            return;
        }

        lobby.broadcastGameState();
    });

    socket.on('music:propose', ({ url }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;

        if (isRateLimited(socket.id, 'music:propose', 5, 10000)) {
            socket.emit('error', { message: 'Too many song proposals. Please wait a bit.' });
            return;
        }

        const proposal = lobby.addMusicProposal(url, playerId, player.name);
        if (!proposal) {
            socket.emit('error', { message: 'Please paste a valid YouTube link.' });
            return;
        }

        socket.emit('music:proposal-sent', { ok: true, proposalId: proposal.id });
        lobby.broadcastGameState();
    });

    socket.on('music:proposal:approve', ({ proposalId, playNow }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;
        if (!proposalId || typeof proposalId !== 'string') return;

        const approved = lobby.approveMusicProposal(proposalId, Boolean(playNow));
        if (!approved) return;
        lobby.broadcastGameState();
    });

    socket.on('music:proposal:reject', ({ proposalId }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;
        if (!proposalId || typeof proposalId !== 'string') return;

        if (!lobby.rejectMusicProposal(proposalId)) return;
        lobby.broadcastGameState();
    });

    socket.on('music:queue:play', ({ trackId }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;
        if (!trackId || typeof trackId !== 'string') return;

        if (!lobby.setCurrentTrack(trackId)) return;
        lobby.broadcastGameState();
    });

    socket.on('music:queue:move', ({ trackId, direction }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;
        if (!trackId || typeof trackId !== 'string') return;
        if (direction !== 'up' && direction !== 'down') return;

        if (!lobby.moveTrack(trackId, direction)) return;
        lobby.broadcastGameState();
    });

    socket.on('music:queue:remove', ({ trackId }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;
        if (!trackId || typeof trackId !== 'string') return;

        if (!lobby.removeTrack(trackId)) return;
        lobby.broadcastGameState();
    });

    socket.on('music:queue:next', () => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;

        lobby.playNextTrack();
        lobby.broadcastGameState();
    });

    socket.on('music:player-ended', ({ trackId }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) return;
        if (!trackId || typeof trackId !== 'string') return;
        if (lobby.music.currentTrackId !== trackId) return;

        lobby.playNextTrack();
        lobby.broadcastGameState();
    });

    socket.on('music:title:update', ({ trackId, title }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;
        if (!trackId || typeof trackId !== 'string') return;
        if (!title || typeof title !== 'string') return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;

        const isHost = lobby.hostId === playerId;
        if (!isHost) return;

        if (!lobby.updateTrackTitle(trackId, title)) return;
        lobby.broadcastGameState();
    });

    socket.on('ranked:config', (config) => {
        if (!config || typeof config !== 'object') return;
        const url = typeof config.url === 'string' ? config.url : '';
        const anonKey = typeof config.anonKey === 'string' ? config.anonKey : '';
        if (url && anonKey) setSupabaseRuntimeConfig(url, anonKey);
    });

    // ========== GAME CONTROLS ==========
    socket.on('game:start', () => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby || lobby.hostId !== playerId) {
            socket.emit('error', { message: 'დაწყება მხოლოდ ჰოსტს შეუძლია' });
            return;
        }

        if (lobby.players.length < 2) {
            socket.emit('error', { message: 'საჭიროა მინიმუმ 2 მოთამაშე' });
            return;
        }

        if (lobby.settings.rankedMode) {
            const hasGuestPlayer = lobby.players.some(p => !String(p.id || '').startsWith('discord_'));
            if (hasGuestPlayer) {
                socket.emit('error', { message: 'Ranked რეჟიმისთვის ყველა მოთამაშე Discord-ით უნდა იყოს ავტორიზებული' });
                return;
            }
        }

        if (lobby.startGame()) {
            broadcastLobbyList();
        }
    });

    socket.on('game:typing', (data) => {
        // Security: Rate limit typing events (max 20 per second)
        if (isRateLimited(socket.id, 'typing', 20, 1000)) return;

        // Security: Validate data exists and has text property
        if (!data || typeof data.text !== 'string') return;

        const playerId = socketToPlayer.get(socket.id);
        if (!playerId) return;

        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;

        // Security: All validation happens inside updateTyping
        lobby.updateTyping(playerId, data.text);
    });

    socket.on('game:submit', (data) => {
        // Security: Rate limit submit events (max 5 per second)
        if (isRateLimited(socket.id, 'submit', 5, 1000)) return;

        // Security: Validate data exists and has word property
        if (!data || typeof data.word !== 'string') return;

        const playerId = socketToPlayer.get(socket.id);
        if (!playerId) return;

        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;

        const result = lobby.submitWord(playerId, data.word);

        if (!result.success) {
            socket.emit('game:word-rejected', { reason: result.reason });
        }
    });

    socket.on('game:ready', () => {
        const playerId = socketToPlayer.get(socket.id);
        if (!playerId) return;

        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;

        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;

        // Security: Only allow ready toggle in waiting state
        if (lobby.state !== 'waiting') return;

        const lobbyPlayer = lobby.players.find(p => p.id === playerId);
        if (lobbyPlayer && lobbyPlayer.isConnected) {
            lobbyPlayer.isReady = !lobbyPlayer.isReady;
            lobby.broadcastGameState();
        }
    });

    // ========== DISCONNECTION ==========
    socket.on('disconnect', () => {
        const playerId = socketToPlayer.get(socket.id);
        const player = playerId ? players.get(playerId) : null;
        console.log(`❌ Disconnected: ${socket.id} (${player?.name || 'unknown'})`);

        handleLeaveLobby(socket, true);

        if (playerId) {
            // Keep player data for 5 minutes for reconnection
            setTimeout(() => {
                const currentSocketId = playerToSocket.get(playerId);
                if (currentSocketId === socket.id) {
                    // Player hasn't reconnected with a new socket
                    const player = players.get(playerId);

                    // If player is still in a lobby that's waiting, remove them
                    if (player?.currentLobbyId) {
                        const lobby = lobbies.get(player.currentLobbyId);
                        if (lobby && lobby.state === 'waiting') {
                            lobby.removePlayer(playerId);
                            if (lobby.players.length === 0) {
                                lobby.destroy();
                                lobbies.delete(lobby.id);
                            } else {
                                lobby.broadcastGameState();
                            }
                            broadcastLobbyList();
                        }
                    }

                    // Clean up mappings but keep player data a bit longer
                    socketToPlayer.delete(socket.id);
                    playerToSocket.delete(playerId);
                }
            }, 300000); // 5 minutes
        }
    });
});

function handleLeaveLobby(socket, isDisconnect = false) {
    const playerId = socketToPlayer.get(socket.id);
    if (!playerId) return;

    const player = players.get(playerId);
    if (!player?.currentLobbyId) return;

    const lobby = lobbies.get(player.currentLobbyId);
    if (!lobby) return;

    if (isDisconnect) {
        // Mark as disconnected but keep in lobby for reconnection
        lobby.markDisconnected(playerId);
        lobby.broadcastGameState();
        console.log(`📴 ${player.name} disconnected from lobby ${lobby.code} (keeping slot)`);

        // If game is waiting, remove after shorter timeout
        if (lobby.state === 'waiting') {
            setTimeout(() => {
                const currentPlayer = players.get(playerId);
                const lobbyPlayer = lobby.players.find(p => p.id === playerId);
                if (lobbyPlayer && !lobbyPlayer.isConnected) {
                    lobby.removePlayer(playerId);
                    if (currentPlayer) currentPlayer.currentLobbyId = null;

                    if (lobby.players.length === 0) {
                        console.log(`🗑️ Deleting empty lobby: ${lobby.code}`);
                        lobby.destroy();
                        lobbies.delete(lobby.id);
                    } else {
                        lobby.broadcastGameState();
                    }
                    broadcastLobbyList();
                }
            }, 30000); // 30 seconds for waiting lobbies
        }
    } else {
        // Intentional leave - remove from lobby
        lobby.removePlayer(playerId);
        socket.leave(lobby.id);
        player.currentLobbyId = null;

        if (lobby.players.length === 0) {
            console.log(`🗑️ Deleting empty lobby: ${lobby.code}`);
            lobby.destroy();
            lobbies.delete(lobby.id);
        } else {
            lobby.broadcastGameState();
        }

        broadcastLobbyList();
    }
}

// ============== START SERVER ==============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 Bomb Party Server running on http://localhost:${PORT}\n`);
});

