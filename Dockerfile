FROM node:14.15.1

# Create app directory
WORKDIR /usr/src/app

RUN apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv 9DA31620334BD75D9DCB49F368818C72E52529D4
# https://community.mongodb.com/t/debian-install-issue-using-apt-repo-no-package-header/1791
# https://jira.mongodb.org/browse/SERVER-46938
ADD http://repo.mongodb.org/apt/debian/dists/stretch/mongodb-org/4.0/main/binary-amd64/mongodb-org-tools_4.0.3_amd64.deb /tmp/mongodb-org-tools.deb
RUN dpkg -i /tmp/mongodb-org-tools.deb
#RUN echo "deb http://repo.mongodb.org/apt/debian stretch/mongodb-org/4.0 main" | tee /etc/apt/sources.list.d/mongodb-org-4.0.list
#RUN apt-get update -y && \
#    apt-get install -y mongodb-org-tools=4.0.3

# Configure git
RUN git config --global user.name "Stackbit" && \
    git config --global user.email "projects@stackbit.com"

ARG NPM_TOKEN
ENV NPM_TOKEN $NPM_TOKEN

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./
COPY .npmrc ./

RUN npm install
# If you are building your code for production
# RUN npm install --only=production

# Bundle app source
COPY . .

RUN rm -rf /usr/src/app/.git

# Preload stackbit-factory versions
RUN npm config set //registry.npmjs.org/:_authToken=${NPM_TOKEN} && \
    npm install @stackbit/stackbit-factory@^0.2.0 --no-save --no-package-lock --prefix data/stackbit-factory/v$(npm show @stackbit/stackbit-factory@^0.2.0 version | tail -1 | cut -d' ' -f2 | sed "s/'//g") && \
    npm install @stackbit/stackbit-factory@^0.3.0 --no-save --no-package-lock --prefix data/stackbit-factory/v$(npm show @stackbit/stackbit-factory@^0.3.0 version | tail -1 | cut -d' ' -f2 | sed "s/'//g")

ARG NODE_ENV=development
ENV NODE_ENV $NODE_ENV

ARG AWS_ACCESS_KEY_ID
ENV AWS_ACCESS_KEY_ID $AWS_ACCESS_KEY_ID

ARG AWS_SECRET_ACCESS_KEY
ENV AWS_SECRET_ACCESS_KEY $AWS_SECRET_ACCESS_KEY

ARG CONFIG_ENV
ENV CONFIG_ENV $CONFIG_ENV

RUN npm run build-without-config

ENV PORT 3000
EXPOSE 3000

CMD eval `ssh-agent -s` && npm run build-config:"$CONFIG_ENV" && npm run build && npm run start:no-build
