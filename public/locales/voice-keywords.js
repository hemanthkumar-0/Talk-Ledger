/**
 * Spoken Field Normalization Keyword Dictionaries (Per Language, Native + Romanized)
 * NOTE: Non-English keyword lists are marked `needs native review` for regional phrasing accuracy.
 */

export const LOCAL_SCRIPT_DIGITS = {
  // Devanagari (Hindi)
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
  // Kannada
  '೦': '0', '೧': '1', '೨': '2', '೩': '3', '೪': '4',
  '೫': '5', '೬': '6', '೭': '7', '೮': '8', '೯': '9',
  // Tamil
  '௦': '0', '௧': '1', '௨': '2', '௩': '3', '௪': '4',
  '௫': '5', '௬': '6', '௭': '7', '௮': '8', '௯': '9',
  // Urdu / Eastern Arabic-Indic
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

export const VOICE_FIELD_KEYWORDS = {
  en: {
    reviewStatus: 'reviewed',
    fillers: [
      'my name is', 'i am', 'this is', 'call me', 'name is', 'my email is', 'email is', 'uh', 'um', 'please',
    ],
    symbols: {
      '@': ['at the rate of', 'at the rate', 'at rate', 'at sign', 'at'],
      '.': ['dot', 'point', 'period'],
      '_': ['underscore', 'under score'],
      '-': ['hyphen', 'dash', 'minus'],
      '+': ['plus'],
    },
    digits: {
      zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
      five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    },
  },
  hi: {
    reviewStatus: 'needs native review',
    fillers: [
      'मेरा नाम', 'मेरा नाम है', 'मैं', 'मेरा ईमेल', 'ईमेल है',
      'mera naam', 'mera naam hai', 'main', 'mera email', 'email hai', 'hai',
    ],
    symbols: {
      '@': ['एट द रेट ऑफ', 'एट द रेट', 'एट रेट', 'एट', 'at the rate of', 'at the rate', 'at'],
      '.': ['डॉट', 'बिंदु', 'पॉइंट', 'dot'],
      '_': ['अंडरस्कोर', 'underscore'],
      '-': ['डैश', 'हाइफ़न', 'हाइफन', 'dash', 'hyphen'],
      '+': ['प्लस', 'plus'],
    },
    digits: {
      'शून्य': '0', 'जीरो': '0', 'एक': '1', 'दो': '2', 'तीन': '3', 'चार': '4',
      'पांच': '5', 'पाँच': '5', 'छह': '6', 'सात': '7', 'आठ': '8', 'नौ': '9',
      shunya: '0', ek: '1', do: '2', teen: '3', char: '4', chaar: '4',
      panch: '5', paanch: '5', chhe: '6', saat: '7', aath: '8', nau: '9',
    },
  },
  kn: {
    reviewStatus: 'needs native review',
    fillers: [
      'ನನ್ನ ಹೆಸರು', 'ನಾನು', 'ನನ್ನ ಇಮೇಲ್', 'ಇಮೇಲ್',
      'nanna hesaru', 'naanu', 'nanna email',
    ],
    symbols: {
      '@': ['ಅಟ್ ದಿ ರೇಟ್ ಆಫ್', 'ಅಟ್ ದಿ ರೇಟ್', 'ಅಟ್', 'ಎಟ್', 'at the rate of', 'at the rate', 'at'],
      '.': ['ಡಾಟ್', 'ಬಿಂದು', 'dot'],
      '_': ['ಅಂಡರ್‌ಸ್ಕೋರ್', 'ಅಂಡರ್ಸ್ಕೋರ್', 'underscore'],
      '-': ['ಡ್ಯಾಶ್', 'ಹೈಫನ್', 'dash', 'hyphen'],
      '+': ['ಪ್ಲಸ್', 'plus'],
    },
    digits: {
      'ಸೊನ್ನೆ': '0', 'ಒಂದು': '1', 'ಎರಡು': '2', 'ಮೂರು': '3', 'ನಾಲ್ಕು': '4',
      'ಐದು': '5', 'ಆರು': '6', 'ಏಳು': '7', 'ಎಂಟು': '8', 'ಒಂಬತ್ತು': '9',
      sonne: '0', ondu: '1', eradu: '2', mooru: '3', naalku: '4',
      aidu: '5', aaru: '6', elu: '7', entu: '8', ombattu: '9',
    },
  },
  ta: {
    reviewStatus: 'needs native review',
    fillers: [
      'என் பெயர்', 'எனது பெயர்', 'நான்', 'என் மின்னஞ்சல்',
      'en peyar', 'enadhu peyar', 'naan', 'en email',
    ],
    symbols: {
      '@': ['அட் தி ரேட் ஆஃப்', 'அட் தி ரேட்', 'அட்', 'at the rate of', 'at the rate', 'at'],
      '.': ['டாட்', 'புள்ளி', 'dot'],
      '_': ['அண்டர்ஸ்கோர்', 'underscore'],
      '-': ['டேஷ்', 'ஹைபன்', 'dash', 'hyphen'],
      '+': ['பிளஸ்', 'plus'],
    },
    digits: {
      'பூஜ்யம்': '0', 'ஒன்று': '1', 'இரண்டு': '2', 'மூன்று': '3', 'நான்கு': '4',
      'ஐந்து': '5', 'ஆறு': '6', 'ஏழு': '7', 'எட்டு': '8', 'ஒன்பது': '9',
      poojyam: '0', ondru: '1', irandu: '2', moondru: '3', naanku: '4',
      ainthu: '5', aaru: '6', ezhu: '7', ettu: '8', onpathu: '9',
    },
  },
  ur: {
    reviewStatus: 'needs native review',
    fillers: [
      'میرا نام', 'میں', 'میرا ای میل', 'mera naam', 'mera email',
    ],
    symbols: {
      '@': ['ایٹ دی ریٹ', 'ایٹ', 'at the rate', 'at'],
      '.': ['ڈاٹ', 'نقطہ', 'dot'],
      '_': ['انڈرسکور', 'underscore'],
      '-': ['ڈیش', 'ہائفن', 'dash', 'hyphen'],
      '+': ['پلس', 'plus'],
    },
    digits: {
      'صفر': '0', 'ایک': '1', 'دو': '2', 'تین': '3', 'چار': '4',
      'پانچ': '5', 'چھ': '6', 'سات': '7', 'آٹھ': '8', 'نو': '9',
      sifar: '0', ek: '1', do: '2', teen: '3', char: '4',
      panch: '5', chhe: '6', saat: '7', aath: '8', nau: '9',
    },
  },
};

export const COMMON_EMAIL_DOMAINS = [
  { keyword: 'gmail', domain: 'gmail.com' },
  { keyword: 'yahoo', domain: 'yahoo.com' },
  { keyword: 'outlook', domain: 'outlook.com' },
];
