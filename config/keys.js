// backend/config/keys.js
require('dotenv').config();

// 기본 키와 솔트 (개발 환경용)
const DEFAULT_ENCRYPTION_KEY = 'a'.repeat(64); // 32바이트를 hex로 표현
const DEFAULT_PASSWORD_SALT = 'b'.repeat(32); // 16바이트를 hex로 표현

let redisClusterNodes = [];
if (process.env.REDIS_CLUSTER_NODES) {
  try {
    redisClusterNodes = JSON.parse(process.env.REDIS_CLUSTER_NODES);
  } catch (err) {
    console.error('Failed to parse REDIS_CLUSTER_NODES from env:', err);
    redisClusterNodes = [];
  }
}

module.exports = {
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
  passwordSalt: process.env.PASSWORD_SALT || DEFAULT_PASSWORD_SALT,
  openaiApiKey: process.env.OPENAI_API_KEY,
  vectorDbEndpoint: process.env.VECTOR_DB_ENDPOINT,
  redisClusterNodes,
};