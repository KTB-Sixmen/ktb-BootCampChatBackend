# 기본 Node.js 이미지를 사용합니다. 프로덕션 환경을 위해 slim 버전 사용
FROM node:18-slim

# 작업 디렉토리를 설정합니다
WORKDIR /usr/src/app

# 앱 의존성 설치를 위한 package.json과 package-lock.json을 복사합니다
COPY package*.json ./

# 프로덕션 의존성만 설치하여 이미지 크기를 최적화합니다
RUN npm ci --only=production

# 소스 코드를 복사합니다
COPY . .

# 소스 코드의 소유권을 node 사용자로 변경합니다
RUN chown -R node:node .

# 보안을 위해 non-root 사용자로 전환합니다
USER node

# 애플리케이션이 사용할 포트를 노출합니다
EXPOSE 5000 8081

# 애플리케이션을 실행합니다
CMD ["node", "server.js"]