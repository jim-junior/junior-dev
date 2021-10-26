FROM lambci/lambda:build-nodejs10.x


WORKDIR /usr/src/app

COPY package*.json ./
COPY .npmrc ./

ARG NPM_TOKEN
ENV NPM_TOKEN $NPM_TOKEN

RUN ln -s /usr/lib64/libcurl.so.4 /usr/lib64/libcurl-gnutls.so.4

RUN rm -rf node_modules
RUN rm -rf .serverless

RUN npm install

RUN npm install -g serverless@1.51.0

# Bundle app source
COPY . .

ARG NODE_ENV=development
ENV NODE_ENV $NODE_ENV

ARG STAGE=dev
ENV STAGE $STAGE

ARG AWS_ACCESS_KEY_ID
ENV AWS_ACCESS_KEY_ID $AWS_ACCESS_KEY_ID
ARG AWS_SECRET_ACCESS_KEY
ENV AWS_SECRET_ACCESS_KEY $AWS_SECRET_ACCESS_KEY

ARG CONFIG_ENV

ARG STACKBIT_SECRETS

RUN npm run build-config:$CONFIG_ENV

RUN cp /usr/lib64/libcurl-gnutls.so*  .

RUN serverless config credentials --provider aws --key $AWS_ACCESS_KEY_ID --secret $AWS_SECRET_ACCESS_KEY

CMD serverless deploy --conceal --stage $STAGE --secrets $STACKBIT_SECRETS
