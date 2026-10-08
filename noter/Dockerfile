FROM node:24-alpine

WORKDIR /app

# Install exactly what package-lock.json records, so the image runs the
# versions that were reviewed and tested rather than whatever the ranges
# resolve to on the day it is built. The optional dependencies are the light
# client (@bizinikiwi/connect, smoldot), which the bot never loads: it talks to
# the chains over WsProvider.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

COPY bot.js ./

CMD ["node", "bot.js"]
