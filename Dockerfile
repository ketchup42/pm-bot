FROM node:26-bookworm AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run check && npm prune --omit=dev

FROM node:26-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules

ENTRYPOINT ["node", "--max-old-space-size=6144", "dist/app/pm-bot.js"]
