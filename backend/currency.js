// 汇率换算 + 货币格式化模块
// 基准货币：人民币 (CNY)，汇率以 2025 年中常见汇率为基准（相对稳定，适合攻略估算）
// 如需实时汇率，可扩展接入开放 API

// 1 人民币 = X 外币（外币/人民币 直接标价）
// 即：CNY 1 = 外币 RATE
const RATES = {
  CNY: 1,
  USD: 0.138,
  EUR: 0.126,
  GBP: 0.108,
  JPY: 21.5,
  KRW: 192,
  HKD: 1.08,
  TWD: 4.45,
  SGD: 0.185,
  MYR: 0.645,
  THB: 4.72,
  IDR: 2180,
  VND: 3450,
  PHP: 7.72,
  INR: 11.5,
  AUD: 0.212,
  NZD: 0.228,
  CAD: 0.188,
  CHF: 0.122,
  SEK: 1.45,
  NOK: 1.42,
  DKK: 0.94,
  RUB: 13.2,
  BRL: 0.70,
  MXN: 2.35,
  ARS: 185,
  ZAR: 2.55,
  EGP: 4.25,
  AED: 0.507,
  SAR: 0.518,
  TRY: 4.65,
  PLN: 0.55,
  CZK: 3.15,
  HUF: 48.5,
  ILS: 0.50
};

const CURRENCY_INFO = {
  CNY: { symbol: '¥', name: 'Chinese Yuan', nameLocal: '人民币', format: 'zh-CN' },
  USD: { symbol: '$', name: 'US Dollar', nameLocal: 'US Dollar', format: 'en-US' },
  EUR: { symbol: '€', name: 'Euro', nameLocal: 'Euro', format: 'de-DE' },
  GBP: { symbol: '£', name: 'British Pound', nameLocal: 'British Pound', format: 'en-GB' },
  JPY: { symbol: '¥', name: 'Japanese Yen', nameLocal: '日本円', format: 'ja-JP' },
  KRW: { symbol: '₩', name: 'South Korean Won', nameLocal: '한국 원', format: 'ko-KR' },
  HKD: { symbol: 'HK$', name: 'Hong Kong Dollar', nameLocal: '港幣', format: 'zh-HK' },
  TWD: { symbol: 'NT$', name: 'Taiwan Dollar', nameLocal: '新台幣', format: 'zh-TW' },
  SGD: { symbol: 'S$', name: 'Singapore Dollar', nameLocal: 'Singapore Dollar', format: 'en-SG' },
  MYR: { symbol: 'RM', name: 'Malaysian Ringgit', nameLocal: 'Ringgit Malaysia', format: 'ms-MY' },
  THB: { symbol: '฿', name: 'Thai Baht', nameLocal: 'บาทไทย', format: 'th-TH' },
  IDR: { symbol: 'Rp', name: 'Indonesian Rupiah', nameLocal: 'Rupiah Indonesia', format: 'id-ID' },
  VND: { symbol: '₫', name: 'Vietnamese Dong', nameLocal: 'Đồng Việt Nam', format: 'vi-VN' },
  PHP: { symbol: '₱', name: 'Philippine Peso', nameLocal: 'Pilipinas Piso', format: 'fil-PH' },
  INR: { symbol: '₹', name: 'Indian Rupee', nameLocal: 'भारतीय रुपया', format: 'hi-IN' },
  AUD: { symbol: 'A$', name: 'Australian Dollar', nameLocal: 'Australian Dollar', format: 'en-AU' },
  NZD: { symbol: 'NZ$', name: 'New Zealand Dollar', nameLocal: 'New Zealand Dollar', format: 'en-NZ' },
  CAD: { symbol: 'C$', name: 'Canadian Dollar', nameLocal: 'Canadian Dollar', format: 'en-CA' },
  CHF: { symbol: 'CHF', name: 'Swiss Franc', nameLocal: 'Schweizer Franken', format: 'de-CH' },
  SEK: { symbol: 'kr', name: 'Swedish Krona', nameLocal: 'svensk krona', format: 'sv-SE' },
  NOK: { symbol: 'kr', name: 'Norwegian Krone', nameLocal: 'norsk krone', format: 'nb-NO' },
  DKK: { symbol: 'kr', name: 'Danish Krone', nameLocal: 'dansk krone', format: 'da-DK' },
  RUB: { symbol: '₽', name: 'Russian Ruble', nameLocal: 'российский рубль', format: 'ru-RU' },
  BRL: { symbol: 'R$', name: 'Brazilian Real', nameLocal: 'Real brasileiro', format: 'pt-BR' },
  MXN: { symbol: 'Mex$', name: 'Mexican Peso', nameLocal: 'Peso mexicano', format: 'es-MX' },
  ARS: { symbol: 'AR$', name: 'Argentine Peso', nameLocal: 'Peso argentino', format: 'es-AR' },
  ZAR: { symbol: 'R', name: 'South African Rand', nameLocal: 'Suid-Afrikaanse Rand', format: 'af-ZA' },
  EGP: { symbol: 'E£', name: 'Egyptian Pound', nameLocal: 'الجنيه المصري', format: 'ar-EG' },
  AED: { symbol: 'د.إ', name: 'UAE Dirham', nameLocal: 'درهم إماراتي', format: 'ar-AE' },
  SAR: { symbol: '﷼', name: 'Saudi Riyal', nameLocal: 'ريال سعودي', format: 'ar-SA' },
  TRY: { symbol: '₺', name: 'Turkish Lira', nameLocal: 'Türk Lirası', format: 'tr-TR' },
  PLN: { symbol: 'zł', name: 'Polish Zloty', nameLocal: 'polski złoty', format: 'pl-PL' },
  CZK: { symbol: 'Kč', name: 'Czech Koruna', nameLocal: 'česká koruna', format: 'cs-CZ' },
  HUF: { symbol: 'Ft', name: 'Hungarian Forint', nameLocal: 'magyar forint', format: 'hu-HU' },
  ILS: { symbol: '₪', name: 'Israeli Shekel', nameLocal: 'שקל ישראלי', format: 'he-IL' }
};

// 语言与默认货币映射（游客来自哪个语言区，通常用哪种货币）
const LANG_DEFAULT_CURRENCY = {
  '中文': 'CNY',
  '中文(繁体)': 'TWD',
  'English': 'USD',
  'English (UK)': 'GBP',
  'English (AU)': 'AUD',
  'English (CA)': 'CAD',
  '日本語': 'JPY',
  '한국어': 'KRW',
  'Français': 'EUR',
  'Deutsch': 'EUR',
  'Español': 'EUR',
  'Español (MX)': 'MXN',
  'Italiano': 'EUR',
  'Português': 'EUR',
  'Português (BR)': 'BRL',
  'Русский': 'RUB',
  'ไทย': 'THB',
  'Tiếng Việt': 'VND',
  'Bahasa Indonesia': 'IDR',
  'Bahasa Melayu': 'MYR',
  'Filipino': 'PHP',
  'हिन्दी': 'INR',
  'العربية': 'AED',
  'Türkçe': 'TRY'
};

// 金额换算：从源货币转为目标货币
function convert(amount, fromCurrency, toCurrency) {
  if (!RATES[fromCurrency]) throw new Error(`不支持的源货币: ${fromCurrency}`);
  if (!RATES[toCurrency]) throw new Error(`不支持的目标货币: ${toCurrency}`);
  if (fromCurrency === toCurrency) return amount;
  // 先转为人民币，再转为目标货币
  const inCny = amount / RATES[fromCurrency];
  return Math.round(inCny * RATES[toCurrency] * 100) / 100;
}

// 格式化金额输出
function format(amount, currency, localeHint) {
  const info = CURRENCY_INFO[currency] || CURRENCY_INFO.USD;
  const locale = localeHint || info.format || 'en-US';
  // 日元、韩元等小数无意义，取整
  const isNoDecimal = ['JPY', 'KRW', 'IDR', 'VND', 'HUF', 'ARS'].includes(currency);
  const fractionDigits = isNoDecimal ? 0 : (amount >= 1000 ? 0 : 2);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    }).format(amount);
  } catch {
    // Intl 不支持时降级
    const symbol = info.symbol;
    const n = isNoDecimal ? Math.round(amount) : amount.toFixed(fractionDigits);
    return `${symbol}${Number(n).toLocaleString()}`;
  }
}

// 换算并格式化
function convertAndFormat(amount, fromCurrency, toCurrency, localeHint) {
  const converted = convert(amount, fromCurrency, toCurrency);
  return format(converted, toCurrency, localeHint);
}

// 获取所有可用货币列表（供前端下拉）
function listCurrencies() {
  return Object.entries(CURRENCY_INFO).map(([code, info]) => ({
    code,
    symbol: info.symbol,
    name: info.name,
    nameLocal: info.nameLocal
  }));
}

// 获取语言→默认货币
function getDefaultCurrencyForLanguage(lang) {
  return LANG_DEFAULT_CURRENCY[lang] || 'USD';
}

module.exports = {
  RATES,
  CURRENCY_INFO,
  LANG_DEFAULT_CURRENCY,
  convert,
  format,
  convertAndFormat,
  listCurrencies,
  getDefaultCurrencyForLanguage
};
