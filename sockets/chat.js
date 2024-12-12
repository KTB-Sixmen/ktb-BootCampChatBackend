// backend/sockets/chat.js

const { Kafka } = require("kafkajs");
const Message = require("../models/Message");
const Room = require("../models/Room");
const User = require("../models/User");
const File = require("../models/File");
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../config/keys");
const redisClient = require("../utils/redisClient");
const SessionService = require("../services/sessionService");
const aiService = require("../services/aiService");

const { createAdapter } = require("@socket.io/redis-adapter");
const { Cluster } = require("ioredis");

const BATCH_SIZE = 50;
const MESSAGE_LOAD_TIMEOUT = 10000;
const DUPLICATE_LOGIN_TIMEOUT = 10000;
const STREAMING_SESSIONS_KEY = "streaming_sessions";

// Redis 클러스터 노드 하드코딩
const clusterNodes = [
  { host: "43.200.132.202", port: 6379 },
  { host: "43.202.183.198", port: 6379 },
  { host: "54.180.154.20", port: 6379 },
  { host: "3.37.73.237", port: 6379 },
  { host: "43.203.14.223", port: 6379 },
  { host: "3.37.123.80", port: 6379 },
];

// Redis 클러스터 클라이언트 생성 (Socket.IO 어댑터 용)
const pubClient = new Cluster(clusterNodes);
const subClient = pubClient.duplicate();

pubClient.on("connect", () =>
  console.log("Redis Cluster connected (pubClient)")
);
pubClient.on("error", (err) =>
  console.error("Redis Cluster error (pubClient):", err)
);
subClient.on("connect", () =>
  console.log("Redis Cluster connected (subClient)")
);
subClient.on("error", (err) =>
  console.error("Redis Cluster error (subClient):", err)
);

module.exports = function (io) {
  // 채팅방 별 사용자 메시지 카운트
  const roomMessageCountMap = new Map();

  // Redis Adapter 설정
  io.adapter(createAdapter(pubClient, subClient));

  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || "chat-service",
    brokers: process.env.KAFKA_BROKERS
      ? process.env.KAFKA_BROKERS.split(",")
      : ["localhost:9092"],
  });

  const producer = kafka.producer();
  const consumer = kafka.consumer({ groupId: "chat-response-group" });
  const requestConsumer = kafka.consumer({ groupId: "chat-request-group" });

  (async () => {
    try {
      console.log("Kafka Producer 연결 시도...");
      await producer.connect();
      console.log("Kafka Producer 연결 성공");
    } catch (error) {
      console.error("Kafka Producer 연결 실패:", error);
    }

    try {
      console.log("Kafka Response Consumer 연결 시도...");
      await consumer.connect();
      console.log("Kafka Response Consumer 연결 성공");

      await consumer.subscribe({
        topic: "message_responses",
        fromBeginning: true,
      });
      await consumer.subscribe({ topic: "chat_messages", fromBeginning: true });

      await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {
    try {
      const data = JSON.parse(message.value.toString());

      if (topic === "message_responses") {
        const { roomId, userId, result } = data;
        io.to(userId).emit("previousMessagesLoaded", result);
      } else if (topic === "chat_messages") {
        const { roomId, message: chatMessage } = data;

        // AI 메시지인지 확인
        const isAIMessage = chatMessage.type === 'ai';

        // AI 메시지가 아닌 경우에만 'message' 이벤트를 통해 전송
        if (!isAIMessage) {
          io.to(roomId).emit("message", chatMessage);
        }

        // Redis 캐시 업데이트 (AI 메시지 포함)
        const cacheKey = `chat:${roomId}:latest`;
        const cachedData = await redisClient.get(cacheKey);
        let messagesArr = [];

        if (cachedData && cachedData.messages) {
          messagesArr = cachedData.messages;
        } else if (cachedData) {
          // Redis에 messages 배열이 없는 경우 초기화
          messagesArr = [];
        }

        messagesArr.push(chatMessage);

        if (messagesArr.length > BATCH_SIZE) {
          messagesArr.splice(0, messagesArr.length - BATCH_SIZE);
        }

        const hasMore = messagesArr.length === BATCH_SIZE;
        const oldestTimestamp = messagesArr[0]?.timestamp || null;

        const updatedResult = {
          messages: messagesArr,
          hasMore,
          oldestTimestamp,
        };

        await redisClient.setEx(cacheKey, 600, updatedResult);
        console.log(`[Redis] latest 캐시 업데이트: ${cacheKey}`);
      }
    } catch (error) {
      console.error("Kafka consumer(error in eachMessage):", error);
    }
  },
});
    } catch (error) {
      console.error("Kafka Response Consumer 연결 실패:", error);
    }

    try {
      console.log("Kafka Request Consumer 연결 시도...");
      await requestConsumer.connect();
      console.log("Kafka Request Consumer 연결 성공");

      await requestConsumer.subscribe({
        topic: "message_requests",
        fromBeginning: true,
      });

      await requestConsumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            const { roomId, before, userId } = JSON.parse(
              message.value.toString()
            );
            const cacheKey = `chat:${roomId}:before:${before || "noBefore"}`;
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
              await producer.send({
                topic: "message_responses",
                messages: [
                  {
                    value: JSON.stringify({
                      roomId,
                      userId,
                      result: cachedData,
                    }),
                  },
                ],
              });
              return;
            }

            const query = { room: roomId };
            if (before) query.timestamp = { $lt: new Date(before) };

            const messages = await Message.find(query)
              .populate("sender", "name email profileImage")
              .populate({
                path: "file",
                select: "filename originalname mimetype size",
              })
              .sort({ timestamp: -1 })
              .limit(BATCH_SIZE + 1)
              .lean();

            const hasMore = messages.length > BATCH_SIZE;
            const resultMessages = messages.slice(0, BATCH_SIZE);
            const sortedMessages = resultMessages.sort(
              (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
            );

            if (sortedMessages.length > 0) {
              const messageIds = sortedMessages.map((msg) => msg._id);
              await Message.updateMany(
                {
                  _id: { $in: messageIds },
                  "readers.userId": { $ne: userId },
                },
                { $push: { readers: { userId, readAt: new Date() } } }
              );
            }

            const result = {
              messages: sortedMessages,
              hasMore,
              oldestTimestamp: sortedMessages[0]?.timestamp || null,
            };
            await redisClient.setEx(cacheKey, 600, result);

            await producer.send({
              topic: "message_responses",
              messages: [{ value: JSON.stringify({ roomId, userId, result }) }],
            });
          } catch (error) {
            console.error("Error processing message_requests:", error);
          }
        },
      });
    } catch (error) {
      console.error("Kafka Request Consumer 연결 실패:", error);
    }
  })();

  function logDebug(action, data) {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) return next(new Error("Authentication error"));

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) return next(new Error("Invalid token"));

      const existingSockets = await io.in(decoded.user.id).fetchSockets();
      if (existingSockets.length > 0) {
        for (const esocket of existingSockets) {
          esocket.emit("duplicate_login", {
            type: "new_login_attempt",
            deviceInfo: socket.handshake.headers["user-agent"],
            ipAddress: socket.handshake.address,
            timestamp: Date.now(),
          });

          setTimeout(() => {
            esocket.emit("session_ended", {
              reason: "duplicate_login",
              message: "다른 기기에서 로그인하여 현재 세션이 종료되었습니다.",
            });
            esocket.disconnect(true);
          }, DUPLICATE_LOGIN_TIMEOUT);
        }
      }

      const validationResult = await SessionService.validateSession(
        decoded.user.id,
        sessionId
      );
      if (!validationResult.isValid) {
        console.error("Session validation failed:", validationResult);
        return next(new Error(validationResult.message || "Invalid session"));
      }

      const user = await User.findById(decoded.user.id);
      if (!user) return next(new Error("User not found"));

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage,
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();
    } catch (error) {
      console.error("Socket authentication error:", error);
      if (error.name === "TokenExpiredError")
        return next(new Error("Token expired"));
      if (error.name === "JsonWebTokenError")
        return next(new Error("Invalid token"));
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    logDebug("socket connected", {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name,
    });

    if (socket.user) socket.join(socket.user.id);

    socket.on(
      "fetchPreviousMessages",
      async ({ roomId, before, limit = BATCH_SIZE }) => {
        try {
          if (!socket.user) throw new Error("Unauthorized");
          const room = await Room.findOne({
            _id: roomId,
            participants: socket.user.id,
          });
          if (!room) throw new Error("채팅방 접근 권한이 없습니다.");

          socket.emit("messageLoadStart");

          if (before) {
            const query = {
              room: roomId,
              timestamp: { $lt: new Date(before) },
            };
            const result = await loadMessagesDirect(query, limit);
            socket.emit("previousMessagesLoaded", result);
            return;
          }

          const cacheKey = `chat:${roomId}:latest`;
          const cachedData = await redisClient.get(cacheKey);
          if (cachedData) {
            console.log(`[Redis] latest 캐시 히트: ${cacheKey}`);
            socket.emit("previousMessagesLoaded", cachedData);
            return;
          }

          console.log(
            `[Redis] latest 캐시 미스: ${cacheKey}, DB에서 메시지 조회`
          );
          const query = { room: roomId };
          const result = await loadMessagesDirect(query, limit);
          await redisClient.setEx(cacheKey, 600, result);
          socket.emit("previousMessagesLoaded", result);
        } catch (error) {
          console.error("Fetch previous messages error:", error);
          socket.emit("error", {
            type: "LOAD_ERROR",
            message: String(
              error.message || "이전 메시지를 불러오는 중 오류가 발생했습니다."
            ),
          });
        }
      }
    );

    socket.on("chatMessage", async (messageData) => {
      try {
        if (!socket.user) throw new Error("Unauthorized");
        if (!messageData) throw new Error("메시지 데이터가 없습니다.");

        const { room, type, content, fileData } = messageData;
        if (!room) throw new Error("채팅방 정보가 없습니다.");

        const chatRoom = await Room.findOne({
          _id: room,
          participants: socket.user.id,
        });
        if (!chatRoom) throw new Error("채팅방 접근 권한이 없습니다.");

        const sessionValidation = await SessionService.validateSession(
          socket.user.id,
          socket.user.sessionId
        );
        if (!sessionValidation.isValid)
          throw new Error("세션이 만료되었습니다. 다시 로그인해주세요.");

        if (content && content.startsWith("/정답 ")) {
          const answerName = content.substring("/정답 ".length).trim();
          const isCorrect = answerName === "용가리";
          io.to(room).emit("answerCheck", {
            correct: isCorrect,
            username: answerName,
          });
          return;
        }

        const aiMentions = extractAIMentions(content);
        let message;

        logDebug("message received", {
          type,
          room,
          userId: socket.user.id,
          hasFileData: !!fileData,
          hasAIMentions: aiMentions.length,
        });

        switch (type) {
          case "file":
            if (!fileData || !fileData._id)
              throw new Error("파일 데이터가 올바르지 않습니다.");
            const file = await File.findOne({
              _id: fileData._id,
              user: socket.user.id,
            });
            if (!file)
              throw new Error("파일을 찾을 수 없거나 접근 권한이 없습니다.");

            message = new Message({
              room,
              sender: socket.user.id,
              type: "file",
              file: file._id,
              content: content || "",
              timestamp: new Date(),
              reactions: {},
              metadata: {
                fileType: file.mimetype,
                fileSize: file.size,
                originalName: file.originalname,
              },
            });
            break;

          case "text":
            const messageContent = content?.trim() || messageData.msg?.trim();
            if (!messageContent) return;

            message = new Message({
              room,
              sender: socket.user.id,
              content: messageContent,
              type: "text",
              timestamp: new Date(),
              reactions: {},
            });
            break;

          default:
            throw new Error("지원하지 않는 메시지 타입입니다.");
        }

        // DB에 메시지 저장
        await message.save();
        await message.populate([
          { path: "sender", select: "name email profileImage" },
          { path: "file", select: "filename originalname mimetype size" },
        ]);

        await producer.send({
          topic: "chat_messages",
          messages: [{ value: JSON.stringify({ roomId: room, message }) }],
        });

        if (aiMentions.length > 0) {
          for (const ai of aiMentions) {
            const query = content
              .replace(new RegExp(`@${ai}\\b`, "g"), "")
              .trim();
            await handleAIResponse(io, room, ai, query);
          }
        }

        await SessionService.updateLastActivity(socket.user.id);

        /** 가짜 AI 로직 부분 */
        const currentCount = roomMessageCountMap.get(room) || 0;
        const newCount = currentCount + 1;
        roomMessageCountMap.set(room, newCount);

        if (newCount >= 2) {
          const recentMessage = await Message.findOne({ room })
            .sort({ timestamp: -1 })
            .lean();

          if (!recentMessage) {
            throw new Error("최근 메시지를 가져올 수 없습니다.");
          }

          const ghostMsg = await aiService.generateGhostResponse(
            // recentMessage.content,
            message.content,
            "dragonAI"
          );

          // 유령 AI 메시지 전송
          const aiMessage = new Message({
            room,
            content: ghostMsg, // generateGhostResponse로 받은 응답
            type: "ai",
            aiType: "dragonAI", // ghostAI로 설정
            timestamp: new Date(),
            reactions: {},
          });

          await aiMessage.save();

          io.to(room).emit("message", aiMessage);
          await producer.send({
            topic: "chat_messages",
            messages: [
              { value: JSON.stringify({ roomId: room, message: aiMessage }) },
            ],
          });

          // 카운트 초기화
          roomMessageCountMap.set(room, 0);
        }

        logDebug("message processed", {
          messageId: message._id,
          type: message.type,
          room,
        });

        const cacheKey = `chat:${room}:latest`;
        const cachedData = await redisClient.get(cacheKey);
        let messagesArr = [];
        if (cachedData && cachedData.messages) {
          messagesArr = cachedData.messages;
        } else if (cachedData) {
          // Redis에 messages 배열이 없는 경우 초기화
          messagesArr = [];
        }
        messagesArr.push(message.toObject());
        if (messagesArr.length > BATCH_SIZE) {
          messagesArr.splice(0, messagesArr.length - BATCH_SIZE);
        }

        const hasMore = messagesArr.length === BATCH_SIZE;
        const oldestTimestamp = messagesArr[0]?.timestamp || null;
        const updatedResult = {
          messages: messagesArr,
          hasMore,
          oldestTimestamp,
        };

        await redisClient.setEx(cacheKey, 600, updatedResult);
        console.log(`[Redis] latest 캐시 업데이트: ${cacheKey}`);
      } catch (error) {
        console.error("Message handling error:", error);
        socket.emit("error", {
          code: error.code || "MESSAGE_ERROR",
          message: error.message || "메시지 전송 중 오류가 발생했습니다.",
        });
      }
    });

    // 이하 코드는 변동 없음, AI 메시지를 저장할 때도 DB에 메시지 저장하는 로직 포함
    // handleAIResponse 함수 내 onComplete 콜백에서 aiMessage 생성 후 aiMessage.save() 수행 중

    socket.on("joinRoom", async (roomId) => {
      try {
        if (!socket.user) throw new Error("Unauthorized");

        const currentRooms = Array.from(socket.rooms).filter(
          (r) => r !== socket.id
        );
        const currentRoom = currentRooms.length > 0 ? currentRooms[0] : null;
        if (currentRoom === roomId) {
          logDebug("already in room", { userId: socket.user.id, roomId });
          socket.emit("joinRoomSuccess", { roomId });
          return;
        }

        if (currentRoom) {
          logDebug("leaving current room", {
            userId: socket.user.id,
            roomId: currentRoom,
          });
          socket.leave(currentRoom);

          const leaveMsg = {
            room: currentRoom,
            content: `${socket.user.name}님이 퇴장하였습니다.`,
            type: "system",
            timestamp: new Date(),
          };
          const leaveMessage = await Message.create(leaveMsg);

          await producer.send({
            topic: "chat_messages",
            messages: [
              {
                value: JSON.stringify({
                  roomId: currentRoom,
                  message: leaveMessage,
                }),
              },
            ],
          });

          socket.to(currentRoom).emit("userLeft", {
            userId: socket.user.id,
            name: socket.user.name,
          });
        }

        const room = await Room.findByIdAndUpdate(
          roomId,
          { $addToSet: { participants: socket.user.id } },
          { new: true, runValidators: true }
        ).populate("participants", "name email profileImage");

        if (!room) throw new Error("채팅방을 찾을 수 없습니다.");

        socket.join(roomId);

        const joinMsg = {
          room: roomId,
          content: `${socket.user.name}님이 입장하였습니다.`,
          type: "system",
          timestamp: new Date(),
        };
        const joinMessage = await Message.create(joinMsg);

        const messageLoadResult = await loadMessages(socket, roomId);
        const { messages, hasMore, oldestTimestamp } = messageLoadResult;

        // 방에 대한 메시지 카운트 초기화
        roomMessageCountMap.set(roomId, 0);

        const activeStreams = [];
        const allStreamingSessions = await redisClient.hGetAll(
          STREAMING_SESSIONS_KEY
        );
        for (const [messageId, sessionData] of Object.entries(
          allStreamingSessions
        )) {
          const session = JSON.parse(sessionData);
          if (session.room === roomId) {
            activeStreams.push({
              _id: session.messageId,
              type: "ai",
              aiType: session.aiType,
              content: session.content,
              timestamp: session.timestamp,
              isStreaming: true,
            });
          }
        }

        socket.emit("joinRoomSuccess", {
          roomId,
          participants: room.participants,
          messages,
          hasMore,
          oldestTimestamp,
          activeStreams,
        });

        await producer.send({
          topic: "chat_messages",
          messages: [
            { value: JSON.stringify({ roomId, message: joinMessage }) },
          ],
        });

        io.to(roomId).emit("participantsUpdate", room.participants);

        logDebug("user joined room", {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore,
        });
      } catch (error) {
        console.error("Join room error:", error);
        socket.emit("joinRoomError", {
          message: error.message || "채팅방 입장에 실패했습니다.",
        });
      }
    });

    socket.on("leaveRoom", async (roomId) => {
      try {
        if (!socket.user) throw new Error("Unauthorized");

        const currentRooms = Array.from(socket.rooms).filter(
          (r) => r !== socket.id
        );
        const currentRoom = currentRooms.length > 0 ? currentRooms[0] : null;
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id,
        })
          .select("participants")
          .lean();
        if (!room) {
          console.log(`Room ${roomId} not found or user has no access`);
          return;
        }

        socket.leave(roomId);

        const leaveMessage = await Message.create({
          room: roomId,
          content: `${socket.user.name}님이 퇴장하였습니다.`,
          type: "system",
          timestamp: new Date(),
        });

        await producer.send({
          topic: "chat_messages",
          messages: [
            { value: JSON.stringify({ roomId, message: leaveMessage }) },
          ],
        });

        await Room.findByIdAndUpdate(
          roomId,
          { $pull: { participants: socket.user.id } },
          { new: true, runValidators: true }
        ).populate("participants", "name email profileImage");

        // 해당 룸 카운트 초기화
        roomMessageCountMap.delete(roomId);

        console.log(`User ${socket.user.id} left room ${roomId} successfully`);
      } catch (error) {
        console.error("Leave room error:", error);
        socket.emit("error", {
          message: error.message || "채팅방 퇴장 중 오류가 발생했습니다.",
        });
      }
    });

    socket.on("disconnect", async (reason) => {
      if (!socket.user) return;
      try {
        const allStreamingSessions = await redisClient.hGetAll(
          STREAMING_SESSIONS_KEY
        );
        for (const [messageId, sessionData] of Object.entries(
          allStreamingSessions
        )) {
          const session = JSON.parse(sessionData);
          if (session.userId === socket.user.id) {
            await redisClient.hDel(STREAMING_SESSIONS_KEY, messageId);
          }
        }

        const currentRooms = Array.from(socket.rooms).filter(
          (r) => r !== socket.id
        );
        const roomId = currentRooms.length > 0 ? currentRooms[0] : null;

        if (
          roomId &&
          reason !== "client namespace disconnect" &&
          reason !== "duplicate_login"
        ) {
          const leaveMessage = await Message.create({
            room: roomId,
            content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
            type: "system",
            timestamp: new Date(),
          });

          await producer.send({
            topic: "chat_messages",
            messages: [
              { value: JSON.stringify({ roomId, message: leaveMessage }) },
            ],
          });

          await Room.findByIdAndUpdate(
            roomId,
            { $pull: { participants: socket.user.id } },
            { new: true, runValidators: true }
          ).populate("participants", "name email profileImage");

          // 해당 룸 카운트 초기화
          roomMessageCountMap.delete(roomId);
        }

        logDebug("user disconnected", {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId,
        });
      } catch (error) {
        console.error("Disconnect handling error:", error);
      }
    });

    socket.on("force_login", async ({ token }) => {
      try {
        if (!socket.user) return;
        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error("Invalid token");
        }

        socket.emit("session_ended", {
          reason: "force_logout",
          message: "다른 기기에서 로그인하여 현재 세션이 종료되었습니다.",
        });

        socket.disconnect(true);
      } catch (error) {
        console.error("Force login error:", error);
        socket.emit("error", { message: "세션 종료 중 오류가 발생했습니다." });
      }
    });

    socket.on("markMessagesAsRead", async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) throw new Error("Unauthorized");
        if (!Array.isArray(messageIds) || messageIds.length === 0) return;

        await Message.updateMany(
          {
            _id: { $in: messageIds },
            room: roomId,
            "readers.userId": { $ne: socket.user.id },
          },
          { $push: { readers: { userId: socket.user.id, readAt: new Date() } } }
        );

        socket
          .to(roomId)
          .emit("messagesRead", { userId: socket.user.id, messageIds });
      } catch (error) {
        console.error("Mark messages as read error:", error);
        socket.emit("error", {
          message: "읽음 상태 업데이트 중 오류가 발생했습니다.",
        });
      }
    });

    socket.on("messageReaction", async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) throw new Error("Unauthorized");
        const message = await Message.findById(messageId);
        if (!message) throw new Error("메시지를 찾을 수 없습니다.");

        if (type === "add") {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === "remove") {
          await message.removeReaction(reaction, socket.user.id);
        }

        io.to(message.room).emit("messageReactionUpdate", {
          messageId,
          reactions: message.reactions,
        });
      } catch (error) {
        console.error("Message reaction error:", error);
        socket.emit("error", {
          message: error.message || "리액션 처리 중 오류가 발생했습니다.",
        });
      }
    });
  });

  async function loadMessages(socket, roomId, before, limit = BATCH_SIZE) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Message loading timed out")),
        MESSAGE_LOAD_TIMEOUT
      );
    });

    try {
      const query = { room: roomId };
      if (before) query.timestamp = { $lt: new Date(before) };

      const messages = await Promise.race([
        Message.find(query)
          .populate("sender", "name email profileImage")
          .populate({
            path: "file",
            select: "filename originalname mimetype size",
          })
          .sort({ timestamp: -1 })
          .limit(limit + 1)
          .lean(),
        timeoutPromise,
      ]);

      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      if (sortedMessages.length > 0 && socket.user) {
        const messageIds = sortedMessages.map((msg) => msg._id);
        Message.updateMany(
          {
            _id: { $in: messageIds },
            "readers.userId": { $ne: socket.user.id },
          },
          { $push: { readers: { userId: socket.user.id, readAt: new Date() } } }
        )
          .exec()
          .catch((error) => console.error("Read status update error:", error));
      }

      return {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages[0]?.timestamp || null,
      };
    } catch (error) {
      console.error("Load messages error:", error);
      throw error;
    }
  }

  async function loadMessagesDirect(query, limit = BATCH_SIZE) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Message loading timed out")),
        MESSAGE_LOAD_TIMEOUT
      );
    });

    const messages = await Promise.race([
      Message.find(query)
        .populate("sender", "name email profileImage")
        .populate({
          path: "file",
          select: "filename originalname mimetype size",
        })
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean(),
      timeoutPromise,
    ]);

    const hasMore = messages.length > limit;
    const resultMessages = messages.slice(0, limit);
    const sortedMessages = resultMessages.sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );
    const oldestTimestamp = sortedMessages[0]?.timestamp || null;

    return { messages: sortedMessages, hasMore, oldestTimestamp };
  }

  function extractAIMentions(content) {
    if (!content) return [];
    const aiTypes = [
      "wayneAI",
      "consultingAI",
      "spellingAI",
      "refuteAI",
      "agentB",
      "hankangAI",
      // "용가리",
      // "ghostAI",
      // "dragonAI",
    ];
    const mentions = new Set();
    const mentionRegex =
      /@(wayneAI|consultingAI|spellingAI|refuteAI|agentB|hankangAI)\b/g;
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      if (aiTypes.includes(match[1])) mentions.add(match[1]);
    }
    return Array.from(mentions);
  }

  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = "";
    const timestamp = new Date();

    const sessionData = {
      room,
      aiType: aiName,
      content: "",
      messageId,
      timestamp,
      lastUpdate: Date.now(),
      reactions: {},
    };

    await redisClient.hSet(
      STREAMING_SESSIONS_KEY,
      messageId,
      JSON.stringify(sessionData)
    );

    logDebug("AI response started", { messageId, aiType: aiName, room, query });

    io.to(room).emit("aiMessageStart", {
      messageId,
      aiType: aiName,
      timestamp,
    });

    try {
      await aiService.generateResponse(query, aiName, {
        onStart: () =>
          logDebug("AI generation started", { messageId, aiType: aiName }),
        onChunk: async (chunk) => {
          accumulatedContent += chunk.currentChunk || "";
          const updatedSession = {
            ...sessionData,
            content: accumulatedContent,
            lastUpdate: Date.now(),
          };
          await redisClient.hSet(
            STREAMING_SESSIONS_KEY,
            messageId,
            JSON.stringify(updatedSession)
          );

          io.to(room).emit("aiMessageChunk", {
            messageId,
            currentChunk: chunk.currentChunk,
            fullContent: accumulatedContent,
            isCodeBlock: chunk.isCodeBlock,
            timestamp: new Date(),
            aiType: aiName,
            isComplete: false,
          });
        },
        onComplete: async (finalContent) => {
          await redisClient.hDel(STREAMING_SESSIONS_KEY, messageId);

          const aiMessage = new Message({
            room,
            content: finalContent.content,
            type: "ai",
            aiType: aiName,
            timestamp: new Date(),
            reactions: {},
            metadata: {
              query,
              generationTime: Date.now() - timestamp,
              completionTokens: finalContent.completionTokens,
              totalTokens: finalContent.totalTokens,
            },
          });

          await aiMessage.save();
          await aiMessage.populate([
            { path: "sender", select: "name email profileImage" },
            { path: "file", select: "filename originalname mimetype size" },
          ]);

          await producer.send({
            topic: "chat_messages",
            messages: [
              { value: JSON.stringify({ roomId: room, message: aiMessage }) },
            ],
          });

          io.to(room).emit("aiMessageComplete", {
            messageId,
            _id: aiMessage._id,
            content: finalContent.content,
            aiType: aiName,
            timestamp: new Date(),
            isComplete: true,
            query,
            reactions: {},
          });

          logDebug("AI response completed", {
            messageId,
            aiType: aiName,
            contentLength: finalContent.content.length,
            generationTime: Date.now() - timestamp,
          });
        },
        onError: async (error) => {
          await redisClient.hDel(STREAMING_SESSIONS_KEY, messageId);
          console.error("AI response error:", error);

          io.to(room).emit("aiMessageError", {
            messageId,
            error: error.message || "AI 응답 생성 중 오류가 발생했습니다.",
            aiType: aiName,
          });

          logDebug("AI response error", {
            messageId,
            aiType: aiName,
            error: error.message,
          });
        },
      });
    } catch (error) {
      await redisClient.hDel(STREAMING_SESSIONS_KEY, messageId);
      console.error("AI service error:", error);

      io.to(room).emit("aiMessageError", {
        messageId,
        error: error.message || "AI 서비스 오류가 발생했습니다.",
        aiType: aiName,
      });

      logDebug("AI service error", {
        messageId,
        aiType: aiName,
        error: error.message,
      });
    }
  }

  return io;
};