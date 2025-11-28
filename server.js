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

// Serve static files
app.use(express.static(__dirname));

// Load Georgian words
let WORDS = [];
let SYLLABLES = [];

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
        SYLLABLES = Array.from(syllableMap.entries())
            .filter(([syl, count]) => count >= 50 && count <= 15000 && syl.length >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 200)
            .map(([syl]) => syl);
        
        console.log(`✓ Loaded ${WORDS.length} words and ${SYLLABLES.length} syllables`);
    } catch (err) {
        console.error('Error loading words:', err);
        // Fallback syllables
        SYLLABLES = ['ან', 'ის', 'ერ', 'ობ', 'ას', 'ით', 'ურ', 'ელ', 'არ', 'ებ'];
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

function getRandomSyllable() {
    if (SYLLABLES.length === 0) return 'ან';
    return SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)];
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
        this.name = lobbyName || `${hostName}'s Lobby`;
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
        
        const player = {
            id: playerId,
            name: playerName,
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
    
    startGame() {
        if (this.players.length < 2) return false;
        
        this.state = 'playing';
        this.usedWords.clear();
        this.currentTurnIndex = 0;
        
        this.players.forEach(p => {
            p.lives = this.settings.startLives;
            p.currentInput = '';
        });
        
        console.log(`🎮 Game started in lobby ${this.code} with ${this.players.length} players`);
        this.nextTurn();
        return true;
    }
    
    nextTurn() {
        let checks = 0;
        while (this.players[this.currentTurnIndex]?.lives <= 0 && checks < this.players.length) {
            this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
            checks++;
        }
        
        this.currentSyllable = getRandomSyllable();
        this.timerValue = this.settings.turnTime;
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
        
        const loser = this.players[this.currentTurnIndex];
        if (!loser) return;
        
        loser.lives--;
        loser.currentInput = '';
        
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
        if (this.state !== 'playing') return { success: false, reason: 'Game not in progress' };
        
        const currentPlayer = this.players[this.currentTurnIndex];
        if (!currentPlayer || currentPlayer.id !== playerId) {
            return { success: false, reason: 'Not your turn' };
        }
        
        const normalizedWord = word.trim().toLowerCase();
        
        if (normalizedWord.length < this.settings.minWordLength) {
            return { success: false, reason: 'Word too short' };
        }
        
        if (this.usedWords.has(normalizedWord)) {
            return { success: false, reason: 'Word already used' };
        }
        
        if (!validateWord(normalizedWord, this.currentSyllable)) {
            return { success: false, reason: 'Invalid word or doesn\'t contain syllable' };
        }
        
        this.usedWords.add(normalizedWord);
        currentPlayer.currentInput = '';
        this.lastActivity = Date.now();
        
        if (this.timer) clearInterval(this.timer);
        
        const bonusTime = Math.min(3, Math.floor(normalizedWord.length / 4));
        
        console.log(`✓ ${currentPlayer.name} submitted: ${word}`);
        this.broadcastWordSuccess(playerId, word, bonusTime);
        
        setTimeout(() => {
            this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
            this.nextTurn();
        }, 500);
        
        return { success: true };
    }
    
    updateTyping(playerId, text) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.currentInput = text;
            this.lastActivity = Date.now();
            this.broadcastTyping(playerId, text);
        }
    }
    
    endGame() {
        if (this.timer) clearInterval(this.timer);
        
        this.state = 'finished';
        const winner = this.getAlivePlayers()[0];
        
        console.log(`🏆 Game ended in ${this.code}. Winner: ${winner?.name || 'Nobody'}`);
        this.broadcastGameEnd(winner);
        
        setTimeout(() => {
            this.state = 'waiting';
            this.players.forEach(p => {
                p.isReady = false;
                p.lives = this.settings.startLives;
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
                isConnected: p.isConnected,
                isReady: p.isReady,
                currentInput: p.currentInput
            })),
            hostId: this.hostId,
            currentTurnIndex: this.currentTurnIndex,
            currentSyllable: this.currentSyllable,
            timerValue: this.timerValue,
            timerMax: this.settings.turnTime,
            settings: this.settings
        });
    }
    
    broadcastTimerUpdate() {
        io.to(this.id).emit('game:timer', {
            timerValue: this.timerValue,
            timerMax: this.settings.turnTime
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
    
    broadcastWordSuccess(playerId, word, bonusTime) {
        io.to(this.id).emit('game:word-success', { playerId, word, bonusTime });
    }
    
    broadcastGameEnd(winner) {
        io.to(this.id).emit('game:end', { 
            winner: winner ? {
                id: winner.id,
                name: winner.name,
                avatar: winner.avatar
            } : null
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
        
        console.log(`📥 Join lobby request: ${lobbyCode} from ${player.name} (${playerId})`);
        
        const lobby = Array.from(lobbies.values()).find(l => l.code === lobbyCode.toUpperCase());
        
        if (!lobby) {
            console.log(`❌ Lobby not found: ${lobbyCode}`);
            socket.emit('error', { message: 'Lobby not found' });
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
                socket.emit('error', { message: 'Game in progress - cannot join' });
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
                    socket.emit('error', { message: 'Cannot join lobby (full?)' });
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
            socket.emit('error', { message: 'Only host can start' });
            return;
        }
        
        if (lobby.players.length < 2) {
            socket.emit('error', { message: 'Need at least 2 players' });
            return;
        }
        
        if (lobby.startGame()) {
            broadcastLobbyList();
        }
    });
    
    socket.on('game:typing', ({ text }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;
        
        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;
        
        lobby.updateTyping(playerId, text);
    });
    
    socket.on('game:submit', ({ word }) => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;
        
        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;
        
        const result = lobby.submitWord(playerId, word);
        
        if (!result.success) {
            socket.emit('game:word-rejected', { reason: result.reason });
        }
    });
    
    socket.on('game:ready', () => {
        const playerId = socketToPlayer.get(socket.id);
        const player = players.get(playerId);
        if (!player?.currentLobbyId) return;
        
        const lobby = lobbies.get(player.currentLobbyId);
        if (!lobby) return;
        
        const lobbyPlayer = lobby.players.find(p => p.id === playerId);
        if (lobbyPlayer) {
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
