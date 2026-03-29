const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  // Recommended for many concurrent users:
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// waiting pool: array of { socket, interests, age, language, gender, pref }
let waiting = [];

function matchPercent(a, b) {
  if (!a.length || !b.length) return 0;
  const common = a.filter((x) => b.includes(x));
  return Math.floor((common.length / Math.max(a.length, b.length)) * 100);
}

function genderCompatible(userA, userB) {
  // userA wants to match userB's gender, and vice versa
  const aWantsB = userA.pref === "any" || userA.pref === userB.gender || userB.gender === "any";
  const bWantsA = userB.pref === "any" || userB.pref === userA.gender || userA.gender === "any";
  return aWantsB && bWantsA;
}

io.on("connection", (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on("start", (user) => {
    // Validate input
    const safeUser = {
      socket,
      interests: Array.isArray(user.interests) ? user.interests.slice(0, 20) : [],
      age: Number(user.age) || 0,
      language: ["eng", "tag"].includes(user.language) ? user.language : "eng",
      gender: ["m", "f", "any"].includes(user.gender) ? user.gender : "any",
      pref: ["m", "f", "any"].includes(user.pref) ? user.pref : "any",
    };

    // Find a compatible waiting user
    const idx = waiting.findIndex((u) => {
      const ageOk = (safeUser.age < 18 && u.age < 18) || (safeUser.age >= 18 && u.age >= 18);
      const langOk = safeUser.language === u.language;
      const genderOk = genderCompatible(safeUser, u);
      return ageOk && langOk && genderOk;
    });

    if (idx !== -1) {
      const partner = waiting.splice(idx, 1)[0];
      const percent = matchPercent(safeUser.interests, partner.interests);

      socket.partner = partner.socket;
      partner.socket.partner = socket;

      socket.emit("matched", { percent, strangerGender: partner.gender });
      partner.socket.emit("matched", { percent, strangerGender: safeUser.gender });

      console.log(`[~] matched ${socket.id} ↔ ${partner.socket.id} | ${percent}% | ${safeUser.language}`);
    } else {
      waiting.push(safeUser);
      console.log(`[?] waiting pool: ${waiting.length}`);
    }
  });

  socket.on("cancel", () => {
    waiting = waiting.filter((u) => u.socket !== socket);
    console.log(`[x] cancelled, pool: ${waiting.length}`);
  });

  socket.on("message", (msg) => {
    if (typeof msg !== "string" || msg.length > 2000) return;
    socket.partner?.emit("message", msg);
  });

  socket.on("typing", () => {
    socket.partner?.emit("typing");
  });

  socket.on("end", () => {
    socket.partner?.emit("end");
    if (socket.partner) socket.partner.partner = null;
    socket.partner = null;
  });

  socket.on("disconnect", () => {
    waiting = waiting.filter((u) => u.socket !== socket);
    socket.partner?.emit("end");
    if (socket.partner) socket.partner.partner = null;
    socket.partner = null;
    console.log(`[-] ${socket.id} | pool: ${waiting.length}`);
  });
});

// Optional: health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", waiting: waiting.length, connections: io.engine.clientsCount });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✦ server on :${PORT}`));
