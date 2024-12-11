// backend/utils/redisClient.js
const Redis = require('redis');
const { redisHost, redisPort } = require('../config/keys');

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 5;
    this.retryDelay = 5000;
  }

  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    try {
      console.log('Connecting to Redis...');

      this.client = Redis.createClient({
        url: `redis://${redisHost}:${redisPort}`,
        socket: {
          host: redisHost,
          port: redisPort,
          reconnectStrategy: (retries) => {
            if (retries > this.maxRetries) {
              return null;
            }
            return Math.min(retries * 50, 2000);
          }
        }
      });

      this.client.on('connect', () => {
        console.log('Redis Client Connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err);
        this.isConnected = false;
      });

      await this.client.connect();
      return this.client;

    } catch (error) {
      console.error('Redis connection error:', error);
      this.isConnected = false;
      this.retryConnection();
      throw error;
    }
  }

  retryConnection() {
    if (this.connectionAttempts < this.maxRetries) {
      this.connectionAttempts++;
      console.log(`Retrying Redis connection... Attempt ${this.connectionAttempts}`);
      setTimeout(() => this.connect(), this.retryDelay);
    } else {
      console.error('Max Redis connection retries reached.');
    }
  }

  async set(key, value, options = {}) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      if (options.ttl) {
        return await this.client.setEx(key, options.ttl, stringValue);
      }
      return await this.client.set(key, stringValue);
    } catch (error) {
      console.error('Redis set error:', error);
      throw error;
    }
  }

  async get(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      const value = await this.client.get(key);
      if (!value) return null;

      try {
        return JSON.parse(value);
      } catch (parseError) {
        // 문자열인 경우 그대로 반환
        return value;
      }
    } catch (error) {
      console.error('Redis get error:', error);
      throw error;
    }
  }

  async setEx(key, seconds, value) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      return await this.client.setEx(key, seconds, stringValue);
    } catch (error) {
      console.error('Redis setEx error:', error);
      throw error;
    }
  }

  async del(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      return await this.client.del(key);
    } catch (error) {
      console.error('Redis del error:', error);
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      return await this.client.expire(key, seconds);
    } catch (error) {
      console.error('Redis expire error:', error);
      throw error;
    }
  }

  async quit() {
    if (this.client) {
      try {
        await this.client.quit();
        this.isConnected = false;
        this.client = null;
        console.log('Redis connection closed successfully');
      } catch (error) {
        console.error('Redis quit error:', error);
        throw error;
      }
    }
  }

  // 키 패턴에 해당하는 모든 키 삭제 함수
  async delPattern(pattern) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      const keys = await this.client.keys(pattern);
      if (keys.length === 0) return 0;

      const pipeline = this.client.multi();
      keys.forEach(key => pipeline.del(key));
      const results = await pipeline.exec();
      // results는 [[null, 1], [null, 1], ...] 형태, 성공한 삭제 개수 계산 가능
      let deletedCount = 0;
      for (const [err, reply] of results) {
        if (!err && reply === 1) deletedCount++;
      }
      return deletedCount;
    } catch (error) {
      console.error('Redis delPattern error:', error);
      throw error;
    }
  }
}

const redisClient = new RedisClient();
module.exports = redisClient;