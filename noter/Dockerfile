FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install \
    @pezkuwi/api@^16.5.36 \
    @pezkuwi/keyring@^14.0.25 \
    @pezkuwi/util@^14.0.25 \
    @pezkuwi/util-crypto@^14.0.25

COPY bot.js ./

CMD ["node", "bot.js"]
