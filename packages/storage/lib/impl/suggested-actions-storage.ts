import { createStorage, StorageEnum } from '../base/index.js';

interface SuggestedAction {
  id: string;
  label: string;
  prompt: string;
}

const localeActions: Record<string, SuggestedAction[]> = {
  en: [
    { id: '1', label: 'Summarize this page', prompt: 'Summarize the active tab in browser for me' },
    { id: '2', label: 'Latest AI trends', prompt: 'What are the latest AI trends?' },
    { id: '3', label: 'Weather in San Francisco', prompt: 'What is the weather in San Francisco?' },
    { id: '4', label: 'Plan a trip to Hawaii', prompt: 'Plan a 5-day trip to Hawaii for me' },
  ],
  zh_CN: [
    { id: '1', label: '总结当前页面', prompt: '帮我总结浏览器当前标签页的内容' },
    { id: '2', label: '最新AI趋势', prompt: '最新的AI发展趋势是什么？' },
    { id: '3', label: '北京天气', prompt: '北京今天天气怎么样？' },
    { id: '4', label: '三亚5日游', prompt: '帮我规划一个三亚5日游行程' },
  ],
  zh_TW: [
    { id: '1', label: '摘要目前頁面', prompt: '幫我摘要瀏覽器目前分頁的內容' },
    { id: '2', label: '最新AI趨勢', prompt: '最新的AI發展趨勢是什麼？' },
    { id: '3', label: '台北天氣', prompt: '台北今天天氣如何？' },
    { id: '4', label: '墾丁5日遊', prompt: '幫我規劃一個墾丁5日遊行程' },
  ],
  ja: [
    { id: '1', label: 'このページを要約', prompt: 'ブラウザの現在のタブの内容を要約してください' },
    { id: '2', label: '最新のAIトレンド', prompt: '最新のAIトレンドは何ですか？' },
    { id: '3', label: '東京の天気', prompt: '東京の今日の天気は？' },
    { id: '4', label: '京都5日間旅行', prompt: '京都への5日間の旅行プランを立ててください' },
  ],
  es: [
    { id: '1', label: 'Resumir esta página', prompt: 'Resume la pestaña activa del navegador para mí' },
    { id: '2', label: 'Tendencias de IA', prompt: '¿Cuáles son las últimas tendencias en IA?' },
    { id: '3', label: 'Clima en Madrid', prompt: '¿Cómo está el clima en Madrid?' },
    { id: '4', label: 'Viaje a Barcelona', prompt: 'Planifica un viaje de 5 días a Barcelona para mí' },
  ],
  de: [
    { id: '1', label: 'Seite zusammenfassen', prompt: 'Fasse den aktiven Browser-Tab für mich zusammen' },
    { id: '2', label: 'Neueste KI-Trends', prompt: 'Was sind die neuesten KI-Trends?' },
    { id: '3', label: 'Wetter in Berlin', prompt: 'Wie ist das Wetter in Berlin?' },
    { id: '4', label: 'Reise nach München', prompt: 'Plane eine 5-tägige Reise nach München für mich' },
  ],
  fr: [
    { id: '1', label: 'Résumer cette page', prompt: "Résume l'onglet actif du navigateur pour moi" },
    { id: '2', label: "Tendances IA", prompt: "Quelles sont les dernières tendances en IA ?" },
    { id: '3', label: 'Météo à Paris', prompt: 'Quel temps fait-il à Paris ?' },
    { id: '4', label: 'Voyage à Nice', prompt: 'Planifie un voyage de 5 jours à Nice pour moi' },
  ],
  nl: [
    { id: '1', label: 'Pagina samenvatten', prompt: 'Vat het actieve browsertabblad voor mij samen' },
    { id: '2', label: 'Nieuwste AI-trends', prompt: 'Wat zijn de nieuwste AI-trends?' },
    { id: '3', label: 'Weer in Amsterdam', prompt: 'Hoe is het weer in Amsterdam?' },
    { id: '4', label: 'Reis naar Barcelona', prompt: 'Plan een 5-daagse reis naar Barcelona voor mij' },
  ],
  ru: [
    { id: '1', label: 'Резюме страницы', prompt: 'Сделай краткое изложение активной вкладки браузера для меня' },
    { id: '2', label: 'Тренды ИИ', prompt: 'Какие последние тренды в сфере ИИ?' },
    { id: '3', label: 'Погода в Москве', prompt: 'Какая сейчас погода в Москве?' },
    { id: '4', label: 'Поездка в Петербург', prompt: 'Спланируй 5-дневную поездку в Санкт-Петербург для меня' },
  ],
  pt: [
    { id: '1', label: 'Resumir esta página', prompt: 'Resuma a aba ativa do navegador para mim' },
    { id: '2', label: 'Tendências de IA', prompt: 'Quais são as últimas tendências em IA?' },
    { id: '3', label: 'Clima em Lisboa', prompt: 'Como está o clima em Lisboa?' },
    { id: '4', label: 'Viagem ao Rio', prompt: 'Planeje uma viagem de 5 dias ao Rio de Janeiro para mim' },
  ],
};

const getDefaultSuggestedActions = (locale?: string): SuggestedAction[] => {
  if (locale && localeActions[locale]) return localeActions[locale];
  // Try base language (e.g. 'zh_CN' → 'zh')
  if (locale) {
    const base = locale.split(/[_-]/)[0];
    if (localeActions[base]) return localeActions[base];
  }
  return localeActions['en'];
};

/** Default IDs used by locale defaults — used to detect uncustomized actions */
const DEFAULT_ACTION_IDS = new Set(['1', '2', '3', '4']);

const isDefaultActions = (actions: SuggestedAction[]): boolean => {
  if (actions.length !== 4) return false;
  return actions.every(a => DEFAULT_ACTION_IDS.has(a.id));
};

// Keep English defaults as the storage initial value (backwards compatible)
const defaultSuggestedActions = localeActions['en'];

const suggestedActionsStorage = createStorage<SuggestedAction[]>(
  'suggested-actions',
  defaultSuggestedActions,
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export type { SuggestedAction };
export { suggestedActionsStorage, defaultSuggestedActions, getDefaultSuggestedActions, isDefaultActions };
