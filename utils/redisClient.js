// backend/utils/redisClient.js
const Redis = require('ioredis');

// 하드코딩된 Redis 클러스터 노드 정보 (예시)
const clusterNodes = [
  { host: '43.200.132.202', port: 6379 },
  { host: '43.202.183.198', port: 6379 },
  { host: '54.180.154.20', port: 6379 },
  { host: '3.37.73.237', port: 6379 },
  { host: '43.203.14.223', port: 6379 },
  { host: '3.37.123.80', port: 6379 },
];

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 5; // 최대 재시도 횟수
    this.retryDelay = 5000; // 재시도 간격 (밀리초)
  }

  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    try {
      console.log('Connecting to Redis Cluster...');

      this.client = new Redis.Cluster(clusterNodes, {
        scaleReads: 'master',
        clusterRetryStrategy: (times) => {
          if (times > this.maxRetries) {
            console.error('Max retries reached for Redis Cluster connection');
            return null;
          }
          return Math.min(times * 100, 3000);
        },
      });

      this.client.on('connect', () => {
        console.log('Redis Cluster Connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('error', (err) => {
        console.error('Redis Cluster Error:', err);
        this.isConnected = false;
        this.retryConnection();
      });

      return this.client;
    } catch (error) {
      console.error('Redis Cluster connection error:', error);
      this.isConnected = false;
      this.retryConnection();
      throw error;
    }
  }

  async hGetAll(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      const data = await this.client.hgetall(key); // ioredis는 hgetall 사용
      return data;
    } catch (error) {
      console.error('Redis hGetAll error:', error);
      throw error;
    }
  }

  async hSet(key, field, value) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      // Redis의 HSET 명령어는 필드와 값을 받아 해시에 설정합니다.
      return await this.client.hset(key, field, value);
    } catch (error) {
      console.error('Redis hSet error:', error);
      throw error;
    }
  }

  async hGet(key, field) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      return await this.client.hget(key, field);
    } catch (error) {
      console.error('Redis hGet error:', error);
      throw error;
    }
  }

  async hDel(key, field) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      return await this.client.hdel(key, field);
    } catch (error) {
      console.error('Redis hDel error:', error);
      throw error;
    }
  }

  retryConnection() {
    if (this.connectionAttempts >= this.maxRetries) {
      console.error('Max Redis cluster connection retries reached.');
      return;
    }
    this.connectionAttempts++;
    console.log(`Retrying Redis Cluster connection... Attempt ${this.connectionAttempts}`);
    setTimeout(() => this.connect(), this.retryDelay);
  }

  async set(key, value, options = {}) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

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
      return this.safeParse(value);
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

  async delPattern(pattern) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      const keys = await this.client.keys(pattern);
      if (keys.length === 0) return 0;

      const pipeline = this.client.multi();
      keys.forEach((key) => pipeline.del(key));
      const results = await pipeline.exec();

      return results.filter(([err, reply]) => !err && reply === 1).length;
    } catch (error) {
      console.error('Redis cluster delPattern error:', error);
      throw error;
    }
  }

  safeParse(data) {
    try {
      return JSON.parse(data);
    } catch {
      return data; // 문자열 그대로 반환
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
}

const redisClient = new RedisClient();
module.exports = redisClient;