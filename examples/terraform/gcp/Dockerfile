# The gateway as a Cloud Run container. Built from a staging directory that
# ./build-and-push.sh assembles — dist/, package.json and the production
# node_modules — so this file installs nothing and the image holds no compiler.
#
# It lives here rather than in gateway/ because it is one deployment target's
# packaging, not part of the gateway package. `npm start` and the compose stack
# run the TypeScript sources directly and need no image at all.
FROM node:22-slim

WORKDIR /app

# package.json is here for its "type": "module". Without it Node reads the .js
# files in dist/ as CommonJS and every import fails.
COPY package.json ./
COPY node_modules ./node_modules
COPY dist ./dist

ENV NODE_ENV=production

# node.ts reads process.env.PORT and Cloud Run injects it (8080), so nothing is
# hardcoded on either side. EXPOSE is documentation; Cloud Run ignores it.
EXPOSE 8080

# Not `npm start`: npm would sit in the process tree as PID 1 and swallow the
# SIGTERM Cloud Run sends when it drains an instance.
CMD ["node", "dist/node.js"]
