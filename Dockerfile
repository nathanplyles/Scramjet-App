FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache python3 py3-pip

RUN pip3 install yt-dlp --break-system-packages --root-user-action=ignore

RUN yt-dlp --js-runtimes node --remote-components ejs:github --skip-download "https://www.youtube.com/watch?v=jNQXAC9IVRw"

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./

RUN pnpm install

COPY . .

EXPOSE 8080

CMD ["pnpm", "start"]
