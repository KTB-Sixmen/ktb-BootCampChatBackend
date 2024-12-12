// backend/utils/redisClient.js
const Redis = require('ioredis');
const { redisClusterNodes } = require('../config/keys');

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
      console.log('Connecting to Redis Cluster...');

      this.client = new Redis.Cluster(redisClusterNodes, {
        scaleReads: 'slave',
        redisOptions: {
          // 필요하다면 비밀번호 설정
          // password: process.env.REDIS_PASSWORD || undefined,
        },
        clusterRetryStrategy: (times) => {
          if (times > this.maxRetries) {
            return null;
          }
          return Math.min(times * 50, 2000);
        }
      });

      this.client.on('connect', () => {
        console.log('Redis Cluster Connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('error', (err) => {
        console.error('Redis Cluster Error:', err);
        this.isConnected = false;
      });

      // // 클러스터 노드 중 하나에 ping을 보내 연결 상태 확인 (선택 사항)
      // await this.client.nodes('master')[0].ping();

      return this.client;
    } catch (error) {
      console.error('Redis Cluster connection error:', error);
      this.isConnected = false;
      this.retryConnection();
      throw error;
    }
  }

  retryConnection() {
    if (this.connectionAttempts < this.maxRetries) {
      this.connectionAttempts++;
      console.log(`Retrying Redis Cluster connection... Attempt ${this.connectionAttempts}`);
      setTimeout(() => this.connect(), this.retryDelay);
    } else {
      console.error('Max Redis cluster connection retries reached.');
    }
  }

  async set(key, value, options = {}) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      let stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

      if (options.ttl) {
        return await this.client.setex(key, options.ttl, stringValue);
      }
      return await this.client.set(key, stringValue);
    } catch (error) {
      console.error('Redis cluster set error:', error);
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
      } catch {
        return value; // 문자열인 경우
      }
    } catch (error) {
      console.error('Redis cluster get error:', error);
      throw error;
    }
  }

  async setEx(key, seconds, value) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return await this.client.setex(key, seconds, stringValue);
    } catch (error) {
      console.error('Redis cluster setEx error:', error);
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
      console.error('Redis cluster del error:', error);
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
      console.error('Redis cluster expire error:', error);
      throw error;
    }
  }

  async quit() {
    if (this.client) {
      try {
        await this.client.quit();
        this.isConnected = false;
        this.client = null;
        console.log('Redis cluster connection closed successfully');
      } catch (error) {
        console.error('Redis cluster quit error:', error);
        throw error;
      }
    }
  }

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

      let deletedCount = 0;
      for (const [err, reply] of results) {
        if (!err && reply === 1) deletedCount++;
      }
      return deletedCount;
    } catch (error) {
      console.error('Redis cluster delPattern error:', error);
      throw error;
    }
  }
}

const redisClient = new RedisClient();
module.exports = redisClient;