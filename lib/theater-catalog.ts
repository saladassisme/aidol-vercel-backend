export type TheaterCatalogLocalizedPack = {
  title: string;
  subtitle: string;
  backgroundHint: string;
  yourRole: string;
  partnerRole: string;
  objective: string;
  openingPrompt: string;
  personaHint: string;
};

export type TheaterCatalogContent = {
  titles: Record<string, string>;
  subtitles: Record<string, string>;
  backgroundHints: Record<string, string>;
  yourRoles: Record<string, string>;
  partnerRoles: Record<string, string>;
  objectives: Record<string, string>;
  openingPrompts: Record<string, string>;
  personaHints: Record<string, string>;
  quickReplies: Record<string, string[]>;
  backgroundImageURL?: string;
  ambientAudioURL?: string;
};

export type TheaterCatalogRow = {
  scenario_key: string;
  sort_order: number;
  is_enabled: boolean;
  system_image: string;
  accent_hex: string;
  backdrop_kind: string;
  content_json: TheaterCatalogContent | null;
};

export type TheaterCatalogItem = {
  key: string;
  sortOrder: number;
  title: string;
  subtitle: string;
  systemImage: string;
  accentHex: string;
  backdrop: string;
  backgroundHint: string;
  yourRole: string;
  partnerRole: string;
  objective: string;
  openingPrompt: string;
  personaHint: string;
  quickReplies: string[];
  backgroundImageURL?: string;
  ambientAudioURL?: string;
};

export type TheaterCatalogPayload = {
  resolvedUiLanguageCode: string;
  resolvedTargetLanguageCode: string;
  scenarios: TheaterCatalogItem[];
};

const DEFAULT_UI_LANGUAGE = 'zh-Hans';
const DEFAULT_TARGET_LANGUAGE = 'en';
const OVERSEA_RESOURCE_BASE_URL = 'https://cdn-aidol.tos-cn-hongkong.volces.com/v1/';
const MAINLAND_RESOURCE_BASE_URL = 'https://cdn-cn-aidol.tos-cn-shanghai.volces.com/v1/';

function normalizeLanguageCode(languageCode: string | null | undefined) {
  const raw = (languageCode || '').trim();
  if (!raw) return '';
  if (raw === 'zh') return 'zh-Hans';
  return raw;
}

function fallbackLanguageCode(
  preferredLanguage: string,
  content: TheaterCatalogContent | null,
  fallbackLanguageCode = DEFAULT_UI_LANGUAGE
) {
  const normalized = normalizeLanguageCode(preferredLanguage);
  const candidates = [normalized, fallbackLanguageCode, 'en'];
  for (const code of candidates) {
    if (!code) continue;
    if (content && (content.titles?.[code] || content.subtitles?.[code] || content.backgroundHints?.[code])) {
      return code;
    }
  }

  const available = content ? Object.keys(content.titles || {}) : [];
  return available[0] || fallbackLanguageCode || DEFAULT_UI_LANGUAGE;
}

function fallbackQuickRepliesLanguageCode(
  preferredLanguage: string,
  content: TheaterCatalogContent | null,
  fallbackLanguageCode = DEFAULT_TARGET_LANGUAGE
) {
  const normalized = normalizeLanguageCode(preferredLanguage);
  const candidates = [normalized, fallbackLanguageCode, 'en', DEFAULT_UI_LANGUAGE];
  for (const code of candidates) {
    if (!code) continue;
    if (content && Array.isArray(content.quickReplies?.[code]) && content.quickReplies[code].length > 0) {
      return code;
    }
  }

  const available = content ? Object.keys(content.quickReplies || {}) : [];
  return available[0] || fallbackLanguageCode || DEFAULT_TARGET_LANGUAGE;
}

function pickText(map: Record<string, string> | undefined, preferredLanguage: string, fallbackLanguage: string) {
  if (!map) return '';
  const normalizedPreferred = normalizeLanguageCode(preferredLanguage);
  const normalizedFallback = normalizeLanguageCode(fallbackLanguage);
  return (
    map[normalizedPreferred] ||
    map[normalizedFallback] ||
    map[DEFAULT_UI_LANGUAGE] ||
    map.en ||
    Object.values(map).find((value) => value.trim().length > 0) ||
    ''
  );
}

function pickQuickReplies(
  map: Record<string, string[]> | undefined,
  preferredLanguage: string,
  fallbackLanguage: string
) {
  if (!map) return [];
  const normalizedPreferred = normalizeLanguageCode(preferredLanguage);
  const normalizedFallback = normalizeLanguageCode(fallbackLanguage);
  const replies =
    map[normalizedPreferred] ||
    map[normalizedFallback] ||
    map[DEFAULT_UI_LANGUAGE] ||
    map.en ||
    Object.values(map).find((value) => Array.isArray(value) && value.length > 0) ||
    [];
  return Array.isArray(replies) ? replies : [];
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}

function joinResourceURL(baseURL: string, relativePath: string) {
  return new URL(relativePath.replace(/^\/+/, ''), ensureTrailingSlash(baseURL)).toString();
}

function defaultTheaterAssetPaths(scenarioKey: string) {
  switch (scenarioKey) {
    case 'coffeeShop':
      return {
        backgroundImageURL: 'TheaterBackgrounds/theater_bg_coffee.jpg',
        ambientAudioURL: 'TheaterBGM/theater_coffee.m4a'
      };
    case 'station':
      return {
        backgroundImageURL: 'TheaterBackgrounds/theater_bg_station.jpg',
        ambientAudioURL: 'TheaterBGM/theater_station.m4a'
      };
    case 'dateDay':
      return {
        backgroundImageURL: 'TheaterBackgrounds/theater_bg_park.jpg',
        ambientAudioURL: 'TheaterBGM/theater_park.m4a'
      };
    case 'signingEvent':
      return {
        backgroundImageURL: 'TheaterBackgrounds/theater_bg_signing.jpg',
        ambientAudioURL: 'TheaterBGM/theater_signing.m4a'
      };
    case 'custom':
      return {
        ambientAudioURL: 'TheaterBGM/theater_custom.m4a'
      };
    default:
      return {};
  }
}

function resolveAssetURL(
  value: string | undefined,
  resourceBaseURL: string,
  defaultRelativePath?: string
) {
  const trimmed = value?.trim();
  if (trimmed) {
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    return joinResourceURL(resourceBaseURL, trimmed);
  }

  if (!defaultRelativePath) {
    return undefined;
  }

  return joinResourceURL(resourceBaseURL, defaultRelativePath);
}

function resolveItem(
  row: TheaterCatalogRow,
  uiLanguageCode: string,
  targetLanguageCode: string,
  resourceBaseURL: string
): TheaterCatalogItem {
  const content = row.content_json;
  const fallbackUiLanguageCode = fallbackLanguageCode(uiLanguageCode, content, DEFAULT_UI_LANGUAGE);
  const fallbackTargetLanguageCode = fallbackQuickRepliesLanguageCode(targetLanguageCode, content, DEFAULT_TARGET_LANGUAGE);
  const defaultAssets = defaultTheaterAssetPaths(row.scenario_key);

  return {
    key: row.scenario_key,
    sortOrder: row.sort_order,
    title: pickText(content?.titles, uiLanguageCode, fallbackUiLanguageCode),
    subtitle: pickText(content?.subtitles, uiLanguageCode, fallbackUiLanguageCode),
    systemImage: row.system_image,
    accentHex: row.accent_hex,
    backdrop: row.backdrop_kind,
    backgroundHint: pickText(content?.backgroundHints, uiLanguageCode, fallbackUiLanguageCode),
    yourRole: pickText(content?.yourRoles, uiLanguageCode, fallbackUiLanguageCode),
    partnerRole: pickText(content?.partnerRoles, uiLanguageCode, fallbackUiLanguageCode),
    objective: pickText(content?.objectives, uiLanguageCode, fallbackUiLanguageCode),
    openingPrompt: pickText(content?.openingPrompts, uiLanguageCode, fallbackUiLanguageCode),
    personaHint: pickText(content?.personaHints, uiLanguageCode, fallbackUiLanguageCode),
    quickReplies: pickQuickReplies(content?.quickReplies, targetLanguageCode, fallbackTargetLanguageCode),
    backgroundImageURL: resolveAssetURL(content?.backgroundImageURL, resourceBaseURL, defaultAssets.backgroundImageURL),
    ambientAudioURL: resolveAssetURL(content?.ambientAudioURL, resourceBaseURL, defaultAssets.ambientAudioURL)
  };
}

export function theaterCatalogRowsToPayload(
  rows: TheaterCatalogRow[],
  uiLanguageCode: string,
  targetLanguageCode: string,
  resourceBaseURL: string = OVERSEA_RESOURCE_BASE_URL
): TheaterCatalogPayload {
  const resolvedUiLanguageCode = fallbackLanguageCode(
    uiLanguageCode,
    rows[0]?.content_json ?? null,
    DEFAULT_UI_LANGUAGE
  );
  const resolvedTargetLanguageCode = fallbackQuickRepliesLanguageCode(
    targetLanguageCode,
    rows[0]?.content_json ?? null,
    DEFAULT_TARGET_LANGUAGE
  );

  return {
    resolvedUiLanguageCode,
    resolvedTargetLanguageCode,
    scenarios: rows
      .filter((row) => row.is_enabled)
      .sort((left, right) => (left.sort_order - right.sort_order) || left.scenario_key.localeCompare(right.scenario_key))
      .map((row) => resolveItem(row, resolvedUiLanguageCode, resolvedTargetLanguageCode, resourceBaseURL))
  };
}

export function buildTheaterCatalogSeedPayload(
  resourceBaseURL: string = OVERSEA_RESOURCE_BASE_URL
): TheaterCatalogPayload {
  return {
    resolvedUiLanguageCode: theaterCatalogSeedPayload.resolvedUiLanguageCode,
    resolvedTargetLanguageCode: theaterCatalogSeedPayload.resolvedTargetLanguageCode,
    scenarios: theaterCatalogSeedPayload.scenarios.map((scenario) => {
      const defaultAssets = defaultTheaterAssetPaths(scenario.key);
      return {
        ...scenario,
        backgroundImageURL: resolveAssetURL(scenario.backgroundImageURL, resourceBaseURL, defaultAssets.backgroundImageURL),
        ambientAudioURL: resolveAssetURL(scenario.ambientAudioURL, resourceBaseURL, defaultAssets.ambientAudioURL)
      };
    })
  };
}

export const theaterCatalogSeedPayload: TheaterCatalogPayload = {
  resolvedUiLanguageCode: DEFAULT_UI_LANGUAGE,
  resolvedTargetLanguageCode: DEFAULT_TARGET_LANGUAGE,
  scenarios: [
    {
      key: 'coffeeShop',
      sortOrder: 10,
      title: '咖啡店下单',
      subtitle: '在咖啡店和店员自然下单。',
      systemImage: 'cup.and.saucer.fill',
      accentHex: '#F2A24A',
      backdrop: 'coffee',
      backgroundHint: '咖啡香、收银台和一点暖色灯光。',
      yourRole: '顾客',
      partnerRole: '咖啡店员',
      objective: '自然点单，并在对话里保持礼貌和轻松。',
      openingPrompt: '请先由咖啡店员用自然口吻说出第一句，帮助顾客开始点单。',
      personaHint: '语气要像熟悉的店员，热情但不过度殷勤。',
      quickReplies: ['我要一杯拿铁。', '少糖一点。', '可以打包吗？', '谢谢。']
    },
    {
      key: 'station',
      sortOrder: 20,
      title: '问路等车',
      subtitle: '在车站礼貌问路，顺便等车。',
      systemImage: 'tram.fill',
      accentHex: '#4FA0F8',
      backdrop: 'station',
      backgroundHint: '站台、路标和进站广播的氛围。',
      yourRole: '问路的新乘客',
      partnerRole: '车站工作人员或路人',
      objective: '礼貌问路、确认线路、顺利等车。',
      openingPrompt: '请先由对方先说一句，告诉用户这里可以怎么问路。',
      personaHint: '语气要简短、可靠、像愿意帮忙的路人。',
      quickReplies: ['请问出口在哪？', '公交站近吗？', '谢谢你。', '我再看看。']
    },
    {
      key: 'dateDay',
      sortOrder: 30,
      title: '约会的一天',
      subtitle: '和新朋友自然聊爱好和基础信息。',
      systemImage: 'heart.text.square.fill',
      accentHex: '#F06B8D',
      backdrop: 'park',
      backgroundHint: '公园、长椅、微风和一点轻松的散步感。',
      yourRole: '新朋友',
      partnerRole: '刚认识的新朋友',
      objective: '互相介绍兴趣爱好，找出共同话题。',
      openingPrompt: '请先用对方身份打招呼，并自然引出兴趣爱好。',
      personaHint: '语气要轻松、真诚、带一点心动感。',
      quickReplies: ['你喜欢什么？', '我也很喜欢这个。', '周末有空吗？', '想继续聊聊。']
    },
    {
      key: 'signingEvent',
      sortOrder: 40,
      title: '线下签售会',
      subtitle: '在签售台前排队，和偶像自然互动。',
      systemImage: 'signature',
      accentHex: '#D87CB7',
      backdrop: 'signing',
      backgroundHint: '签售台、闪光灯、排队粉丝和现场低声的应援氛围。',
      yourRole: '来签售的粉丝',
      partnerRole: '签售偶像',
      objective: '自然完成简短互动，表达喜欢并顺利拿到签名。',
      openingPrompt: '请先由签售偶像开口，像在签售台前招呼下一位粉丝。',
      personaHint: '温柔亲切，有一点偶像营业感，但不要太公式化。',
      quickReplies: ['等了好久！', '可以帮我签名吗？', '今天也超好看。', '真的太感谢了。']
    }
  ]
};
