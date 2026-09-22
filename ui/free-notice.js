(() => {
  const copy = {
    zh: {
      title: '必读声明', close: '关闭', sellers: '目前已知的无良倒卖者',
      before: '声明-本软件是免费、开源的软件，作者从未授权任何人售卖其使用许可，本软件在B站（',
      between: '）与Github（',
      after: '）均有免费下载链接，如果你是向某人付费获得的本软件，说明你被骗了。如能申请平台售后，请携带本截图向平台发起售后，卖家的无良倒卖行为将严重伤害每一个为爱发电的作者。感谢你的支持。',
      firstTitle: '本软件免费开源', firstText: '本软件是免费、开源的软件。所有付费售卖者均为倒卖。',
      ack: '收到，不再显示。', saveError: '保存失败，请重试。', linkError: '无法打开浏览器，请复制链接访问。', empty: '暂无图文。',
    },
    en: {
      title: 'READ ME', close: 'CLOSE', sellers: 'Known unauthorized resellers',
      before: 'Statement — This software is free and open source. The author has never authorized anyone to sell licenses to use it. Free downloads are available on Bilibili (',
      between: ') and GitHub (',
      after: '). If you paid someone for this software, you were deceived. If the marketplace offers after-sales support, use this screenshot to request it. Dishonest reselling harms authors who contribute their work for free. Thank you for your support.',
      firstTitle: 'Free and open source', firstText: 'This software is free and open source. Anyone selling it for a fee is a reseller.',
      ack: 'Got it. Do not show again.', saveError: 'Could not save. Please retry.', linkError: 'Could not open the browser. Copy the link to visit it.', empty: 'No listings.',
    },
  };
  const officialLinks = ['https://space.bilibili.com/86682017', 'https://github.com/Ooxygen7/HELLDIVERS2_QuickStratagemTool'];
  const element = id => document.getElementById(id);
  let language = 'zh';
  let version = 0;
  let items = [{ id: 'xianyu-shadow-sam', caption: '闲鱼-影子sam-通过倒卖牟利', src: './assets/resale-listing.jpg' }];
  let initialization;
  let resolveFirstNotice;
  let busy = false;

  function renderItems() {
    const list = element('free-notice-items');
    list.replaceChildren();
    for (const item of items) {
      const figure = document.createElement('figure');
      const caption = document.createElement('figcaption');
      caption.textContent = item.caption;
      const image = document.createElement('img');
      image.src = item.src;
      image.alt = item.caption;
      image.loading = 'lazy';
      image.decoding = 'async';
      figure.append(caption, image);
      list.appendChild(figure);
    }
    if (!items.length) list.textContent = copy[language].empty;
  }

  function applyContent(content) {
    if (!content || !Number.isSafeInteger(content.noticeVersion) || content.noticeVersion <= version
        || !Array.isArray(content.items) || content.items.length > 20) return;
    const valid = content.items.every(item => item && typeof item.id === 'string'
      && typeof item.caption === 'string' && item.caption.length <= 1000
      && ['image/jpeg', 'image/png'].includes(item.image?.mediaType)
      && typeof item.image.base64 === 'string' && item.image.base64.length <= 1398104
      && /^[A-Za-z0-9+/]+={0,2}$/.test(item.image.base64));
    if (!valid) return;
    version = content.noticeVersion;
    items = content.items.map(item => ({ id: item.id, caption: item.caption, src: `data:${item.image.mediaType};base64,${item.image.base64}` }));
    if (element('free-notice-modal').classList.contains('active')) renderItems();
  }

  async function refreshContent() {
    try { applyContent(await window.electronAPI.loadCachedFreeNotice()); } catch { /* Keep bundled content available offline. */ }
    try { applyContent(await window.electronAPI.checkFreeNoticeUpdates()); } catch { /* Content updates never interrupt the user. */ }
  }

  function setLanguage(value) {
    language = value === 'en' ? 'en' : 'zh';
    const text = copy[language];
    element('btn-title-notice').textContent = text.title;
    for (const [id, key] of Object.entries({ 'free-notice-title': 'title', 'free-notice-close': 'close', 'free-notice-sellers-title': 'sellers', 'free-notice-first-title': 'firstTitle', 'free-notice-first-text': 'firstText', 'free-notice-ack': 'ack' })) {
      element(id).textContent = text[key];
    }
    const paragraph = element('free-notice-statement');
    paragraph.replaceChildren(document.createTextNode(text.before));
    officialLinks.forEach((url, index) => {
      const link = document.createElement('a');
      link.href = url;
      link.textContent = url;
      link.onclick = async event => {
        event.preventDefault();
        try {
          if (index === 0) await window.electronAPI.openBilibiliPage();
          else await window.electronAPI.openGitHubRepository();
        } catch { element('free-notice-error').textContent = copy[language].linkError; }
      };
      paragraph.append(link, document.createTextNode(index === 0 ? text.between : text.after));
    });
    if (element('free-notice-modal').classList.contains('active')) renderItems();
  }

  function open() {
    setLanguage(language);
    renderItems();
    element('free-notice-error').textContent = '';
    element('free-notice-modal').classList.add('active');
    element('free-notice-close').focus();
  }
  function close() {
    element('free-notice-modal').classList.remove('active');
    element('btn-title-notice').focus();
  }
  function initialize(value) {
    if (initialization) return initialization;
    setLanguage(value);
    void refreshContent();
    initialization = (async () => {
      let show = false;
      try { show = await window.electronAPI.shouldShowFreeNotice(); } catch { return; }
      if (show !== true) return;
      await new Promise(resolve => {
        resolveFirstNotice = resolve;
        element('free-notice-first-modal').classList.add('active');
        element('free-notice-ack').focus();
      });
    })();
    return initialization;
  }
  element('free-notice-close').onclick = close;
  element('free-notice-ack').onclick = async () => {
    if (busy) return;
    busy = true;
    element('free-notice-ack').disabled = true;
    element('free-notice-first-error').textContent = '';
    try {
      await window.electronAPI.acknowledgeFreeNotice();
      element('free-notice-first-modal').classList.remove('active');
      resolveFirstNotice?.();
      resolveFirstNotice = null;
      element('btn-title-notice').focus();
    } catch { element('free-notice-first-error').textContent = copy[language].saveError; }
    finally { busy = false; element('free-notice-ack').disabled = false; }
  };
  for (const id of ['free-notice-modal', 'free-notice-first-modal']) {
    element(id).addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (id === 'free-notice-modal') close();
      }
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), a[href]')];
      const first = controls[0], last = controls.at(-1);
      if (first && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    });
  }
  window.freeSoftwareNotice = { initialize, setLanguage, open };
})();
