import { Amplify } from 'aws-amplify';
import { config, isConfigured } from './config';

let configured = false;

/** Configure Amplify Auth (Cognito only). Safe to call repeatedly. */
export function configureAmplify() {
  if (configured || !isConfigured) return;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        loginWith: { email: true },
      },
    },
  });
  configured = true;
}
