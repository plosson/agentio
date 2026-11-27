import type { SetupContext } from '../../plugin-sdk';
import { capturePicsiSignIn } from './browser';

/** Picsi's detached postMessage callback cannot return a session to a different-origin opener. */
export async function signInWithBrowser(context: SetupContext): Promise<string> {
  context.log('Opening a separate Picsi sign-in window. Sign in with Discord, then return here.');
  context.log('This window is separate from your normal browser profile and closes when sign-in finishes.');
  return capturePicsiSignIn();
}
