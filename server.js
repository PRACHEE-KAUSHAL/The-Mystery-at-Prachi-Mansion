const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true }));

// A player who refreshes has 90 seconds to return to the same room.
const rooms = new Map();
const RECONNECT_GRACE_MS = 90 * 1000;
const cleanName = value => String(value || "").trim().slice(0, 24);

function newCode() {
  let code;
  do {
    code = crypto.randomBytes(4).toString("hex").slice(0, 5).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function makePlayer(name, socket) {
  return {
    id: crypto.randomBytes(12).toString("hex"),
    token: crypto.randomBytes(24).toString("hex"),
    name,
    socketId: socket.id,
    connected: true,
    disconnectTimer: null
  };
}

function roomView(room) {
  const players = [...room.players.values()];
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    connectedCount: players.filter(p => p.connected).length,
    voteCount: Object.keys(room.votes).length,
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId
    }))
  };
}

function update(room) {
  io.to(room.code).emit("room:update", roomView(room));
}

function socketRoom(socket) {
  return socket.data.roomCode ? rooms.get(socket.data.roomCode) : null;
}

function attachPlayer(socket, room, player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }

  // Set the new socket first, so the old socket's disconnect cannot remove the player.
  const oldSocketId = player.socketId;
  player.socketId = socket.id;
  player.connected = true;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);

  if (oldSocketId && oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    if (oldSocket) oldSocket.disconnect(true);
  }
}

function removePlayer(room, player) {
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  room.players.delete(player.id);
  delete room.votes[player.id];

  if (room.hostId === player.id) {
    const replacement = [...room.players.values()].find(p => p.connected)
      || room.players.values().next().value;
    room.hostId = replacement ? replacement.id : null;
  }

  if (room.phase === "voting") {
    room.phase = "playing";
    room.votes = {};
    io.to(room.code).emit("game:vote-reset", "A player left. The host can open voting again.");
  }

  if (!room.players.size) {
    rooms.delete(room.code);
    return;
  }
  update(room);
}

io.on("connection", socket => {
  console.log("[CONNECTED]", socket.id);

  socket.on("room:create", (data, cb = () => {}) => {
    const name = cleanName(data?.name);
    if (!name) return cb({ ok: false, error: "Please enter your name." });

    const code = newCode();
    const room = {
      code,
      hostId: null,
      players: new Map(),
      phase: "lobby",
      votes: {},
      culpritId: null
    };
    const player = makePlayer(name, socket);
    room.hostId = player.id;
    room.players.set(player.id, player);
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;

    cb({ ok: true, room: roomView(room), playerId: player.id, playerToken: player.token });
    update(room);
    console.log("[ROOM CREATED]", code, "Host:", name);
  });

  socket.on("room:join", (data, cb = () => {}) => {
    const code = String(data?.code || "").trim().toUpperCase();
    const name = cleanName(data?.name);
    const room = rooms.get(code);

    if (!name) return cb({ ok: false, error: "Please enter your name." });
    if (!/^[A-F0-9]{5}$/.test(code)) {
      return cb({ ok: false, error: "Enter the five-character room code exactly as shown." });
    }
    if (!room) return cb({ ok: false, error: "Room not found. Check the five-character code." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "This game has already started." });
    if (room.players.size >= 12) return cb({ ok: false, error: "This room is full (12 players maximum)." });

    const player = makePlayer(name, socket);
    room.players.set(player.id, player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;

    cb({ ok: true, room: roomView(room), playerId: player.id, playerToken: player.token });
    update(room);
    console.log("[PLAYER JOINED]", name, "Room:", code, "Total:", room.players.size);
  });

  socket.on("room:resume", (data, cb = () => {}) => {
    const code = String(data?.code || "").trim().toUpperCase();
    const token = String(data?.token || "");
    const room = rooms.get(code);

    if (!room || !token) {
      return cb({ ok: false, error: "Your previous room is no longer available. Please create or join a room again." });
    }

    const player = [...room.players.values()].find(p => p.token === token);
    if (!player) {
      return cb({ ok: false, error: "Your place in this room has expired. Please join again with the room code." });
    }

    attachPlayer(socket, room, player);
    cb({ ok: true, room: roomView(room), playerId: player.id, playerToken: player.token });
    update(room);
    console.log("[PLAYER RESUMED]", player.name, "Room:", code);
  });

  socket.on("room:leave", (cb = () => {}) => {
    const room = socketRoom(socket);
    const player = room?.players.get(socket.data.playerId);
    if (room && player && player.socketId === socket.id) removePlayer(room, player);
    delete socket.data.roomCode;
    delete socket.data.playerId;
    cb({ ok: true });
  });

  socket.on("game:start", (cb = () => {}) => {
    const room = socketRoom(socket);
    const playerId = socket.data.playerId;
    if (!room) return cb({ ok: false, error: "Room not found. Please create a new room." });
    if (room.hostId !== playerId) return cb({ ok: false, error: "Only the host can start." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "The game has already started." });

    const players = [...room.players.values()];
    if (players.length < 3 || players.some(p => !p.connected)) {
      return cb({ ok: false, error: "All players must be connected, and at least 3 are needed." });
    }

    room.phase = "playing";
    room.votes = {};
    room.culpritId = players[Math.floor(Math.random() * players.length)].id;

    for (const player of players) {
      io.to(player.socketId).emit("game:role", {
        role: player.id === room.culpritId ? "THE SUSPECT" : "INVESTIGATOR",
        secret: player.id === room.culpritId
          ? "You secretly took the mansion heirloom. Act natural and avoid suspicion."
          : "You are innocent. Discuss the clues and identify the suspect."
      });
    }
    cb({ ok: true });
    update(room);
  });

  socket.on("game:open-vote", (cb = () => {}) => {
    const room = socketRoom(socket);
    if (!room) return cb({ ok: false, error: "Room not found." });
    if (room.hostId !== socket.data.playerId) return cb({ ok: false, error: "Only the host can open voting." });
    if (room.phase !== "playing") return cb({ ok: false, error: "Voting cannot be opened now." });
    if ([...room.players.values()].some(p => !p.connected)) {
      return cb({ ok: false, error: "Everyone must be connected before voting." });
    }

    room.phase = "voting";
    room.votes = {};
    io.to(room.code).emit("game:voting");
    update(room);
    cb({ ok: true });
  });

  socket.on("game:vote", (data, cb = () => {}) => {
    const room = socketRoom(socket);
    const playerId = socket.data.playerId;
    if (!room || room.phase !== "voting") return cb({ ok: false, error: "Voting is not open." });

    const target = data?.targetId;
    if (!room.players.has(target) || target === playerId) {
      return cb({ ok: false, error: "Choose another player." });
    }
    if (room.votes[playerId]) return cb({ ok: false, error: "Your vote has already been counted." });

    room.votes[playerId] = target;
    const total = room.players.size;
    const count = Object.keys(room.votes).length;

    if (count === total) {
      const tally = {};
      Object.values(room.votes).forEach(id => tally[id] = (tally[id] || 0) + 1);
      const max = Math.max(...Object.values(tally));
      const winners = Object.keys(tally).filter(id => tally[id] === max);
      const caught = winners.length === 1 && winners[0] === room.culpritId;
      room.phase = "ended";
      io.to(room.code).emit("game:result", {
        result: caught ? "The suspect was caught! Investigators win." : "The suspect escaped! The mystery remains unsolved.",
        culprit: room.players.get(room.culpritId)?.name || "Unknown",
        votedOut: winners.map(id => room.players.get(id)?.name || "Unknown").join(", "),
        tie: winners.length > 1
      });
    } else {
      io.to(room.code).emit("game:votes", { count, total });
    }
    cb({ ok: true });
    update(room);
  });

  socket.on("disconnect", () => {
    const room = socketRoom(socket);
    const playerId = socket.data.playerId;
    if (!room || !playerId) return;

    const player = room.players.get(playerId);
    // Ignore stale disconnect events from a socket replaced during reconnect.
    if (!player || player.socketId !== socket.id) return;

    player.connected = false;
    player.disconnectTimer = setTimeout(() => {
      const currentRoom = rooms.get(room.code);
      const currentPlayer = currentRoom?.players.get(playerId);
      if (currentRoom && currentPlayer && !currentPlayer.connected) {
        console.log("[RECONNECT TIMEOUT]", currentPlayer.name, "Room:", room.code);
        removePlayer(currentRoom, currentPlayer);
      }
    }, RECONNECT_GRACE_MS);

    console.log("[DISCONNECTED]", player.name, "Room:", room.code, "- reconnect window: 90 seconds");
    update(room);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Prachi Mansion server listening on " + PORT);
});
