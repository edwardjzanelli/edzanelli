/* The token Lambda's function URL, see lambda/session-token/README.md. Its own module so the Voice page, which calls
   the Lambda only for its sentiment score, can import it without loading the LiveAvatar SDK. */
export const TOKEN_URL = "https://bw7rxcyn7l47nrc2f3ors4bwzi0mqzhp.lambda-url.us-west-1.on.aws";
