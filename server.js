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

const rooms = new Map();
const cleanName = value => String(value || "").trim().slice(0, 24);
function newCode() {
  let code;
  do { code = crypto.randomBytes(4).toString("hex").slice(0, 5).toUpperCase(); }
  while (rooms.has(code));
  return code;
}
function roomView(room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase,
    voteCount: Object.keys(room.votes).length,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, isHost: p.id === room.hostId
    }))
  };
}
function update(room) { io.to(room.code).emit("room:update", roomView(room)); }
function socketRoom(socket) {
  return socket.data.roomCode ? rooms.get(socket.data.roomCode) : null;
}

io.on("connection", socket => {
  socket.on("room:create", (data, cb = () => {}) => {
    const name = cleanName(data?.name);
    if (!name) return cb({ ok: false, error: "Please enter your name." });
    const code = newCode();
    const room = {
      code, hostId: socket.id, players: new Map(), phase: "lobby",
      votes: {}, culpritId: null
    };
    room.players.set(socket.id, { id: socket.id, name });
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, room: roomView(room) });
    update(room);
  });

  socket.on("room:join", (data, cb = () => {}) => {
    const code = String(data?.code || "").trim().toUpperCase();
    const name = cleanName(data?.name);
    const room = rooms.get(code);
    if (!name) return cb({ ok: false, error: "Please enter your name." });
    if (!/^[A-F0-9]{5}$/.test(code)) return cb({ ok: false, error: "Enter the five-character room code exactly as shown." });
    if (!room) return cb({ ok: false, error: "Room not found. Check the five-character code." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "This game has already started." });
    if (room.players.size >= 12) return cb({ ok: false, error: "This room is full (12 players maximum)." });

    const previous = socketRoom(socket);
    if (previous) {
      previous.players.delete(socket.id);
      if (!previous.players.size) rooms.delete(previous.code);
      else {
        if (previous.hostId === socket.id) previous.hostId = previous.players.keys().next().value;
        update(previous);
      }
      socket.leave(previous.code);
    }
    room.players.set(socket.id, { id: socket.id, name });
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, room: roomView(room) });
    update(room);
  });

  socket.on("game:start", (cb = () => {}) => {
    const room = socketRoom(socket);
    if (!room) return cb({ ok: false, error: "Room not found. Please create a new room." });
    if (room.hostId !== socket.id) return cb({ ok: false, error: "Only the host can start." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "The game has already started." });
    if (room.players.size < 3) return cb({ ok: false, error: "At least 3 players are needed." });

    room.phase = "playing";
    room.votes = {};
    const players = [...room.players.values()];
    room.culpritId = players[Math.floor(Math.random() * players.length)].id;
    for (const player of players) {
      io.to(player.id).emit("game:role", {
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
    if (room.hostId !== socket.id) return cb({ ok: false, error: "Only the host can open voting." });
    if (room.phase !== "playing") return cb({ ok: false, error: "Voting cannot be opened now." });
    room.phase = "voting";
    room.votes = {};
    io.to(room.code).emit("game:voting");
    update(room);
    cb({ ok: true });
  });

  socket.on("game:vote", (data, cb = () => {}) => {
    const room = socketRoom(socket);
    if (!room || room.phase !== "voting") return cb({ ok: false, error: "Voting is not open." });
    const target = data?.targetId;
    if (!room.players.has(target) || target === socket.id) return cb({ ok: false, error: "Choose another player." });
    if (room.votes[socket.id]) return cb({ ok: false, error: "Your vote has already been counted." });

    room.votes[socket.id] = target;
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
    if (!room) return;
    room.players.delete(socket.id);
    delete room.votes[socket.id];
    if (!room.players.size) { rooms.delete(room.code); return; }
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    if (room.phase === "voting" && Object.keys(room.votes).length >= room.players.size) {
      room.phase = "playing";
      room.votes = {};
      io.to(room.code).emit("game:vote-reset", "A player left. The host can open voting again.");
    }
    update(room);
  });
});

server.listen(PORT, "0.0.0.0", () => console.log("Prachi Mansion server listening on " + PORT));
