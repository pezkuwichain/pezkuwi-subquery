FROM node:24-alpine

WORKDIR /app

# Install exactly what package-lock.json records, so the image runs the
# versions that were reviewed and tested rather than whatever the ranges
# resolve to on the day it is built.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY bot.js ./

CMD ["node", "bot.js"]
