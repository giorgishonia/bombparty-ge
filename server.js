const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

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

// Enable CORS for Express
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

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
    constructor(hostId, hostName, lobbyName, isPublic = true) {
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

        this.afkCheckInterval = null;
        this.startAfkChecker();

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

    addPlayer(playerId, playerName) {
        if (this.players.length >= this.settings.maxPlayers) return false;
        if (this.players.find(p => p.id === playerId)) return true; // Already in lobby

        // Security: Sanitize player name using global function
        const safeName = sanitizeName(playerName);

        const player = {
            id: playerId,
            name: safeName,
            avatar: getRandomAvatar(),
            color: getRandomColor(),
            lives: this.settings.startLives,
            isConnected: true,
            isReady: false,
            currentInput: '',
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


    endGame() {
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
                color: p.color,
                score: p.score || 0,
                wordsCompleted: p.wordsCompleted || 0,
                lives: p.lives
            }));

        const winner = rankings[0];

        console.log(`🏆 Game ended in ${this.code}. Winner: ${winner?.name || 'Nobody'} with ${winner?.score || 0} pts`);
        this.broadcastGameEnd(winner, rankings);

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
            });
            this.broadcastGameState();
            broadcastLobbyList();
        }, 5000);
    }

    broadcastGameState() {
        io.to(this.id).emit('game:state', {
            state: this.state,
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                avatar: p.avatar,
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
            settings: this.settings
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

    broadcastGameEnd(winner, rankings) {
        io.to(this.id).emit('game:end', {
            winner: winner ? {
                id: winner.id,
                name: winner.name,
                avatar: winner.avatar,
                score: winner.score || 0
            } : null,
            rankings: rankings || []
        });
    }
}

// ============== SOCKET HANDLERS ==============

io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);

    // Send lobby list immediately
    socket.emit('lobby:list', getLobbyList());

    // ========== PLAYER AUTH ==========
    socket.on('player:auth', ({ playerId, playerName }) => {
        console.log(`🔑 Auth request: ${playerName} (${playerId || 'new'})`);

        let pid = playerId;
        let isReconnect = false;

        // Check if reconnecting with existing ID
        if (pid && players.has(pid)) {
            isReconnect = true;
            const oldSocketId = playerToSocket.get(pid);
            if (oldSocketId && oldSocketId !== socket.id) {
                socketToPlayer.delete(oldSocketId);
            }
            // Update player data
            const existingPlayer = players.get(pid);
            existingPlayer.name = playerName || existingPlayer.name;
            existingPlayer.socketId = socket.id;
        } else {
            pid = generatePlayerId();
            players.set(pid, {
                id: pid,
                name: playerName || 'Player',
                socketId: socket.id,
                currentLobbyId: null
            });
        }

        socketToPlayer.set(socket.id, pid);
        playerToSocket.set(pid, socket.id);

        socket.emit('player:authed', {
            playerId: pid,
            playerName: playerName || 'Player',
            isReconnect
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
    socket.on('player:restore', ({ playerId, playerName, lobbyId, lobbyCode }) => {
        console.log(`🔄 Restore request: ${playerName} (${playerId}) -> lobby ${lobbyCode || lobbyId}`);

        let pid = playerId;
        let lobby = null;

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
            existingPlayer.name = playerName || existingPlayer.name;

            socketToPlayer.set(socket.id, pid);
            playerToSocket.set(pid, socket.id);

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
            socket.emit('player:restored', { playerId: pid, inLobby: false });
            console.log(`✅ Restored ${playerName} (not in lobby)`);
        } else {
            // Create new player
            pid = generatePlayerId();
            players.set(pid, {
                id: pid,
                name: playerName || 'Guest',
                socketId: socket.id,
                currentLobbyId: null
            });
            socketToPlayer.set(socket.id, pid);
            playerToSocket.set(pid, socket.id);

            socket.emit('player:restore-failed', {
                reason: 'Session expired',
                newPlayerId: pid
            });
            socket.emit('player:authed', { playerId: pid });
            console.log(`❌ Restore failed, created new player: ${pid}`);
        }
    });

    // ========== LOBBY MANAGEMENT ==========
    socket.on('lobby:create', ({ playerName, lobbyName, isPublic }) => {
        // Security: Rate limit lobby creation (max 3 per 10 seconds)
        if (isRateLimited(socket.id, 'lobby:create', 3, 10000)) {
            socket.emit('error', { message: 'ძალიან ბევრი მოთხოვნაა. გთხოვთ დაიცადოთ.' });
            return;
        }

        // Auto-create player if not exists (guest mode)
        let playerId = socketToPlayer.get(socket.id);

        if (!playerId) {
            playerId = generatePlayerId();
            players.set(playerId, {
                id: playerId,
                name: playerName || 'Guest',
                socketId: socket.id,
                currentLobbyId: null
            });
            socketToPlayer.set(socket.id, playerId);
            playerToSocket.set(playerId, socket.id);
            socket.emit('player:authed', { playerId });
            console.log(`👤 Auto-created player: ${playerName} (${playerId})`);
        }

        const player = players.get(playerId);
        player.name = playerName || player.name || 'Guest';

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

        const lobby = new Lobby(playerId, player.name, lobbyName, isPublic !== false);
        lobby.addPlayer(playerId, player.name);
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

        // Auto-create player if not exists (guest mode)
        let playerId = socketToPlayer.get(socket.id);

        if (!playerId) {
            playerId = generatePlayerId();
            players.set(playerId, {
                id: playerId,
                name: safeName,
                socketId: socket.id,
                currentLobbyId: null
            });
            socketToPlayer.set(socket.id, playerId);
            playerToSocket.set(playerId, socket.id);
            socket.emit('player:authed', { playerId });
            console.log(`👤 Auto-created player: ${safeName} (${playerId})`);
        }

        const player = players.get(playerId);
        player.name = safeName || player.name || 'Guest';

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
                if (!lobby.addPlayer(playerId, player.name)) {
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
        if (typeof settings.isPublic === 'boolean') lobby.settings.isPublic = settings.isPublic;

        if (lobby.state !== 'playing') {
            lobby.currentTurnTime = lobby.settings.turnTime;
            lobby.currentMinWordLength = lobby.settings.minWordLength;
        }

        lobby.broadcastGameState();
        broadcastLobbyList();
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
