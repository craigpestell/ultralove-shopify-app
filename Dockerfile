FROM node:24-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci && npm cache clean --force

COPY . .

RUN npm run build

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
