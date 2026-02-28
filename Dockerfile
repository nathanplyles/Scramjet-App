FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache python3 py3-pip && pip3 install yt-dlp --break-system-packages

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./

RUN pnpm install

COPY . .

EXPOSE 8080

CMD ["pnpm", "start"]
