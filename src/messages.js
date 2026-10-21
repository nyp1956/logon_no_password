export const SUPPORTED_LANGUAGES = ['en', 'da'];

export const LANGUAGE_NAMES = {
  en: 'English',
  da: 'Dansk',
};

const messages = {
  en: {
    ui: {
      title: 'Sign in',
      emailLabel: 'E-mail',
      sendLink: 'Send sign-in link',
      waiting: 'We sent a sign-in link to {email}. Open it to confirm the sign-in, then this window updates by itself.',
      resend: 'Send a new link',
      guest: 'Continue without an account',
      signOut: 'Sign out',
      profileTitle: 'Your profile',
      save: 'Save',
      saved: 'Profile saved.',
      close: 'Close',
      signedInAs: 'Signed in as {email}',
      guestMode: 'You are using the app as a guest.',
      linkExpired: 'The link is no longer valid. Request a new one.',
      verifyTitle: 'Confirm sign-in',
      verifyText: 'Confirm that you want to sign in to {appName}.',
      verifyButton: 'Confirm sign-in',
      verifyDone: 'You are signed in. You can close this page.',
      verifyFailed: 'This link is invalid or has expired.',
      verifyOtherBrowser: 'Open this link in the browser where you asked for it.',
      confirmCodeShow: 'Enter this code on the confirm page, for example on your phone:',
      confirmCodeLabel: 'Enter the 6-digit code shown in the browser where you asked for the link',
      verifyBadCode: 'The code is not correct. Check it and try again.',
      language: 'Language',
    },
    errors: {
      invalid_email: 'Enter a valid e-mail address.',
      field_required: '{field} is required.',
      field_too_long: '{field} is too long.',
      field_invalid: '{field} is not valid.',
      send_failed: 'We could not send the e-mail. Try again in a moment.',
      link_invalid: 'The link is invalid or has expired.',
      link_other_browser: 'Open this link in the browser where you asked for it.',
      link_code_invalid: 'The code is not correct.',
      unauthorized: 'Sign in to continue.',
      bad_request: 'The request could not be processed.',
      unknown: 'Something went wrong. Try again.',
    },
    mail: {
      subject: 'Your sign-in link for {appName}',
      text: 'Click the link below to sign in to {appName}.\n\n{link}\n\nThe link expires in {minutes} minutes and can only be used once. If you did not ask for it, you can ignore this e-mail.',
    },
    page: {
      htmlLang: 'en',
    },
  },
  da: {
    ui: {
      title: 'Log ind',
      emailLabel: 'E-mail',
      sendLink: 'Send login-link',
      waiting: 'Vi har sendt et login-link til {email}. Åbn det for at bekræfte login, så opdaterer dette vindue sig selv.',
      resend: 'Send et nyt link',
      guest: 'Fortsæt uden konto',
      signOut: 'Log ud',
      profileTitle: 'Din profil',
      save: 'Gem',
      saved: 'Profilen er gemt.',
      close: 'Luk',
      signedInAs: 'Logget ind som {email}',
      guestMode: 'Du bruger appen som gæst.',
      linkExpired: 'Linket er ikke længere gyldigt. Bed om et nyt.',
      verifyTitle: 'Bekræft login',
      verifyText: 'Bekræft at du vil logge ind på {appName}.',
      verifyButton: 'Bekræft login',
      verifyDone: 'Du er nu logget ind. Du kan lukke denne side.',
      verifyFailed: 'Linket er ugyldigt eller udløbet.',
      verifyOtherBrowser: 'Åbn linket i den browser, hvor du bad om det.',
      confirmCodeShow: 'Indtast denne kode på bekræftelsessiden, fx på din telefon:',
      confirmCodeLabel: 'Indtast den 6-cifrede kode, der vises i den browser, hvor du bad om linket',
      verifyBadCode: 'Koden er ikke korrekt. Tjek den og prøv igen.',
      language: 'Sprog',
    },
    errors: {
      invalid_email: 'Indtast en gyldig e-mailadresse.',
      field_required: '{field} skal udfyldes.',
      field_too_long: '{field} er for lang.',
      field_invalid: '{field} er ikke gyldig.',
      send_failed: 'Vi kunne ikke sende e-mailen. Prøv igen om lidt.',
      link_invalid: 'Linket er ugyldigt eller udløbet.',
      link_other_browser: 'Åbn linket i den browser, hvor du bad om det.',
      link_code_invalid: 'Koden er ikke korrekt.',
      unauthorized: 'Log ind for at fortsætte.',
      bad_request: 'Anmodningen kunne ikke behandles.',
      unknown: 'Noget gik galt. Prøv igen.',
    },
    mail: {
      subject: 'Dit login-link til {appName}',
      text: 'Klik på linket herunder for at logge ind på {appName}.\n\n{link}\n\nLinket udløber om {minutes} minutter og kan kun bruges én gang. Hvis du ikke har bedt om det, kan du ignorere denne e-mail.',
    },
    page: {
      htmlLang: 'da',
    },
  },
};

export function format(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    values[key] !== undefined ? String(values[key]) : `{${key}}`,
  );
}

export function pickLanguage(candidate, fallback = 'en') {
  if (typeof candidate !== 'string') return fallback;
  const base = candidate.toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : fallback;
}

export function getMessages(language) {
  return messages[pickLanguage(language)];
}

export default messages;
