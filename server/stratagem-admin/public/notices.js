(() => {
  const el = id => document.getElementById(`notices-${id}`);
  let items = [];
  let version = null;
  let editingId = null;
  let draftImage = null;
  let busy = false;
  let dirty = false;
  const imageUrl = image => `data:${image.mediaType};base64,${image.base64}`;

  function setBusy(value) {
    busy = value;
    el('dialog').querySelectorAll('button,input,textarea').forEach(control => { control.disabled = value; });
  }
  function finishEdit() {
    el('form').hidden = true;
    el('form').reset();
    el('preview').hidden = true;
    el('preview').removeAttribute('src');
    editingId = null;
    draftImage = null;
    dirty = false;
  }
  function discardDraft() { return !dirty || window.confirm('放弃未保存的图文更改？'); }
  function edit(item = null) {
    if (busy || !discardDraft()) return;
    finishEdit();
    editingId = item?.id || null;
    draftImage = item?.image || null;
    el('caption').value = item?.caption || '';
    el('editor-title').textContent = item ? '编辑图文' : '添加图文';
    el('error').textContent = '';
    el('form').hidden = false;
    if (draftImage) { el('preview').src = imageUrl(draftImage); el('preview').hidden = false; }
    el('caption').focus();
  }
  function render() {
    el('version').textContent = `图文版本 v${version} · ${items.length} / 20 条`;
    el('list').replaceChildren();
    for (const item of items) {
      const card = document.createElement('article');
      const image = document.createElement('img'); image.src = imageUrl(item.image); image.alt = item.caption; image.loading = 'lazy';
      const caption = document.createElement('p'); caption.textContent = item.caption;
      const actions = document.createElement('div'); actions.className = 'notices-toolbar';
      const editButton = document.createElement('button'); editButton.type = 'button'; editButton.className = 'button secondary'; editButton.textContent = '编辑'; editButton.onclick = () => edit(item);
      const removeButton = document.createElement('button'); removeButton.type = 'button'; removeButton.className = 'button danger'; removeButton.textContent = '删除';
      removeButton.onclick = async () => {
        if (busy || !discardDraft() || !window.confirm(`删除这条图文并静默发布？\n${item.caption}`)) return;
        await publish(items.filter(value => value.id !== item.id));
      };
      actions.append(editButton, removeButton); card.append(image, caption, actions); el('list').appendChild(card);
    }
  }
  async function load() {
    const result = await api('notices');
    version = result.manifest.noticeVersion;
    items = result.content.items;
    render();
  }
  async function publish(nextItems) {
    setBusy(true); el('error').textContent = '';
    try {
      const result = await api('notices', { method: 'PUT', body: JSON.stringify({ baseVersion: version, items: nextItems }) });
      version = result.manifest.noticeVersion; items = result.content.items;
      finishEdit(); render(); showToast('图文已静默发布', 'success');
    } catch (error) {
      el('error').textContent = apiErrorMessage(error);
      showToast(apiErrorMessage(error), 'error');
      // Keep the draft intact on a conflict; closing and reopening explicitly reloads the current version.
    } finally { setBusy(false); }
  }
  el('button').onclick = async () => {
    if (busy) return;
    el('dialog').showModal();
    setBusy(true);
    try { await load(); finishEdit(); }
    catch (error) { showToast(apiErrorMessage(error), 'error'); el('dialog').close(); }
    finally { setBusy(false); }
  };
  el('close').onclick = () => { if (!busy && discardDraft()) { finishEdit(); el('dialog').close(); } };
  el('dialog').addEventListener('cancel', event => { if (busy || !discardDraft()) event.preventDefault(); else finishEdit(); });
  el('add').onclick = () => {
    if (items.length >= 20) return showToast('最多可发布 20 条图文', 'error');
    edit();
  };
  el('cancel').onclick = () => { if (discardDraft()) finishEdit(); };
  el('caption').addEventListener('input', () => { dirty = true; });
  el('file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      el('error').textContent = '请选择 5 MiB 以内的 JPEG 或 PNG 图片。'; event.target.value = ''; return;
    }
    setBusy(true); el('error').textContent = '';
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file);
      });
      const result = await api('notices/image', { method: 'POST', body: JSON.stringify({ mediaType: file.type, base64 }) });
      draftImage = result.image; dirty = true;
      el('preview').src = imageUrl(draftImage); el('preview').hidden = false;
    } catch (error) { el('error').textContent = apiErrorMessage(error); }
    finally { setBusy(false); event.target.value = ''; }
  });
  el('form').onsubmit = event => {
    event.preventDefault();
    if (busy) return;
    const caption = el('caption').value.trim();
    if (!caption || !draftImage) { el('error').textContent = '请填写附文并上传图片。'; return; }
    const item = { id: editingId || `listing-${crypto.randomUUID()}`, caption, image: draftImage };
    void publish(editingId ? items.map(value => value.id === editingId ? item : value) : [...items, item]);
  };
  window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });
})();
