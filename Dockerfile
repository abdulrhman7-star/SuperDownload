FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# ffmpeg is used to merge separate video/audio streams and to convert audio.
# Python and pip are included to install the current yt-dlp release.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
    && python3 -m pip install --break-system-packages --no-cache-dir -U yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./server.js
COPY public ./public

EXPOSE 3000
CMD ["npm", "start"]
