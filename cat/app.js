/**
 * 图文墙 —— 纯前端版(私密群组 + 置顶 JSON 索引方案)
 *
 * 存储/索引全部依赖 Telegram,零后端、零数据库、零本地索引文件：
 *   内容本体:直接 sendPhoto/sendMediaGroup/sendMessage 发进私密群组
 *   索引:每个分类群组里置顶一条 JSON 文件消息,记录"有哪些内容、
 *        每条对应哪个 message_id / file_id"。读取用 getChat 直接拿
 *        pinned_message,写入用 editMessageMedia 原地替换这个文件,
 *        message_id 全程不变,永远是同一条被置顶的消息。
 *
 * 并发写入存在竞态(见 README),这里做了"写入前二次核对"的缓解,
 * 不是完美加锁。
 *
 * 写成 ES5 风格(var / function)照顾老浏览器。
 */
(function () {
  'use strict';

  var CFG = window.TG_CONFIG;
  var HAS_FETCH = typeof window.fetch === 'function';
  var HAS_IO = typeof window.IntersectionObserver === 'function';

  var state = {}; // { categoryId: { allItems: [], shown: 0, loading: false, loaded: false } }
  CFG.categories.forEach(function (cat) {
    state[cat.id] = { allItems: [], shown: 0, loading: false, loaded: false };
  });
  var currentCat = CFG.categories[0].id;
  var fileUrlCache = {}; // file_id -> 直链,内存缓存,刷新页面就没了,不算"存储"

  // ================= 通用小工具 =================

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function getCat(id) {
    for (var i = 0; i < CFG.categories.length; i++) if (CFG.categories[i].id === id) return CFG.categories[i];
    return CFG.categories[0];
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, isError) {
    var box = $('#toast');
    box.textContent = msg;
    box.className = 'toast show' + (isError ? ' error' : '');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(function () { box.className = 'toast'; }, 3200);
  }

  // ================= Telegram Bot API 封装 =================

  function tgApiUrl(method) { return 'https://api.telegram.org/bot' + CFG.botToken + '/' + method; }

  function tgGet(method, params, onOk, onFail) {
    var qs = [];
    for (var k in params) { if (params[k] !== undefined && params[k] !== null) qs.push(k + '=' + encodeURIComponent(params[k])); }
    var url = tgApiUrl(method) + (qs.length ? '?' + qs.join('&') : '');
    var handle = function (data) {
      if (!data.ok) { onFail(new Error(data.description || (method + ' 失败'))); return; }
      onOk(data.result);
    };
    if (HAS_FETCH) {
      window.fetch(url).then(function (r) { return r.json(); }).then(handle).catch(onFail);
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        try { handle(JSON.parse(xhr.responseText)); } catch (e) { onFail(e); }
      }
    };
    xhr.onerror = function () { onFail(new Error('network error')); };
    xhr.send();
  }

  function tgPost(method, formData, onOk, onFail, _retried) {
    var handle = function (data) {
      if (!data.ok) {
        var retryAfter = data.parameters && data.parameters.retry_after;
        if (retryAfter && !_retried) {
          toast('发送太频繁,' + retryAfter + ' 秒后自动重试…');
          window.setTimeout(function () { tgPost(method, formData, onOk, onFail, true); }, (retryAfter + 1) * 1000);
          return;
        }
        onFail(new Error(data.description || (method + ' 失败')));
        return;
      }
      onOk(data.result);
    };
    if (HAS_FETCH) {
      window.fetch(tgApiUrl(method), { method: 'POST', body: formData }).then(function (r) { return r.json(); }).then(handle).catch(onFail);
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', tgApiUrl(method), true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) { try { handle(JSON.parse(xhr.responseText)); } catch (e) { onFail(e); } }
    };
    xhr.onerror = function () { onFail(new Error('network error')); };
    xhr.send(formData);
  }

  // 换文件直链(带内存缓存,同一次会话里同一个 file_id 不重复请求)
  function resolveFileUrl(fileId, onOk, onFail) {
    if (fileUrlCache[fileId]) { onOk(fileUrlCache[fileId]); return; }
    tgGet('getFile', { file_id: fileId }, function (result) {
      var url = 'https://api.telegram.org/file/bot' + CFG.botToken + '/' + result.file_path;
      fileUrlCache[fileId] = url;
      onOk(url);
    }, onFail);
  }

  // ================= 索引读写(核心) =================
  // 索引 = 私密群组里置顶的一个 JSON 文档消息。
  // 结构: { items: [ {id, mid, fileIds:[...], text, time}, ... ] }  旧的在前,新的在后

  function fetchPinnedIndexMessage(chatId, onOk, onFail) {
    tgGet('getChat', { chat_id: chatId }, function (chat) {
      onOk(chat.pinned_message || null);
    }, onFail);
  }

  // api.telegram.org/file/... 这个下载路径没开跨域头,直连读取内容大概率被
  // 浏览器拦(图片 <img> 标签不受影响,只有 fetch 读文本受影响)。
  // 这里做直连优先、失败自动切公共代理兜底。
  function fetchTextWithFallback(url, onOk, onFail) {
    var doFetch = function (target, onDone) {
      if (HAS_FETCH) {
        window.fetch(target).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }).then(function (t) { onDone(null, t); }).catch(function (e) { onDone(e); });
        return;
      }
      var xhr = new XMLHttpRequest();
      xhr.open('GET', target, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          xhr.status >= 200 && xhr.status < 300 ? onDone(null, xhr.responseText) : onDone(new Error('HTTP ' + xhr.status));
        }
      };
      xhr.onerror = function () { onDone(new Error('network error')); };
      xhr.send();
    };

    doFetch(url, function (err, text) {
      if (!err) { onOk(text); return; }
      if (!CFG.corsProxy) { onFail(err); return; }
      doFetch(CFG.corsProxy + encodeURIComponent(url), function (err2, text2) {
        if (err2) onFail(err2); else onOk(text2);
      });
    });
  }

  function downloadIndexJson(pinnedMsg, onOk, onFail) {
    if (!pinnedMsg || !pinnedMsg.document) { onOk({ items: [] }); return; }
    resolveFileUrl(pinnedMsg.document.file_id, function (url) {
      fetchTextWithFallback(url, function (text) {
        try { onOk(JSON.parse(text)); } catch (e) { onOk({ items: [] }); }
      }, onFail);
    }, onFail);
  }

  // 把新的完整索引写回去:第一次(没有置顶消息)用 sendDocument + pinChatMessage 建立,
  // 之后每次都用 editMessageMedia 原地替换同一条消息里的文件,message_id 不变。
  function uploadIndex(chatId, existingMsgId, indexObj, onOk, onFail) {
    var blob = new Blob([JSON.stringify(indexObj)], { type: 'application/json' });
    var file = new File([blob], 'index.json', { type: 'application/json' });

    if (!existingMsgId) {
      var fd = new FormData();
      fd.append('chat_id', chatId);
      fd.append('document', file);
      tgPost('sendDocument', fd, function (msg) {
        tgPost('pinChatMessage', (function () { var f = new FormData(); f.append('chat_id', chatId); f.append('message_id', msg.message_id); f.append('disable_notification', 'true'); return f; })(),
          function () { onOk(msg.message_id); }, onFail);
      }, onFail);
      return;
    }

    var fd2 = new FormData();
    fd2.append('chat_id', chatId);
    fd2.append('message_id', existingMsgId);
    fd2.append('media', JSON.stringify({ type: 'document', media: 'attach://index' }));
    fd2.append('index', file);
    tgPost('editMessageMedia', fd2, function () { onOk(existingMsgId); }, onFail);
  }

  // 带"写入前二次核对"的追加操作。mutateFn(items) 返回新的 items 数组。
  function appendToIndex(chatId, mutateFn, onDone, attempt) {
    attempt = attempt || 0;
    fetchPinnedIndexMessage(chatId, function (pinnedMsg) {
      downloadIndexJson(pinnedMsg, function (indexObj) {
        var newItems = mutateFn((indexObj.items || []).slice());

        // 二次核对:提交前再问一次 Telegram 现在置顶的是不是还是同一条、
        // 内容有没有变,变了说明有人抢先写过了,重新来一轮再合并
        fetchPinnedIndexMessage(chatId, function (pinnedMsg2) {
          var before = pinnedMsg && pinnedMsg.document ? pinnedMsg.document.file_unique_id : null;
          var after = pinnedMsg2 && pinnedMsg2.document ? pinnedMsg2.document.file_unique_id : null;
          var msgIdBefore = pinnedMsg ? pinnedMsg.message_id : null;
          var msgIdAfter = pinnedMsg2 ? pinnedMsg2.message_id : null;

          if ((before !== after || msgIdBefore !== msgIdAfter) && attempt < CFG.maxWriteRetries) {
            window.setTimeout(function () {
              appendToIndex(chatId, mutateFn, onDone, attempt + 1);
            }, 250 + Math.random() * 400);
            return;
          }

          uploadIndex(chatId, msgIdAfter, { items: newItems }, function () { onDone(null); }, function (err) {
            if (attempt < CFG.maxWriteRetries) {
              window.setTimeout(function () { appendToIndex(chatId, mutateFn, onDone, attempt + 1); }, 400 + Math.random() * 400);
            } else {
              onDone(err);
            }
          });
        }, onDone);
      }, onDone);
    }, onDone);
  }

  // ================= 渲染 =================

  function timeAgo(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function createCard(item) {
    var card = document.createElement('article');
    card.className = 'card';
    var tilt = (Math.random() * 3.2 - 1.6).toFixed(2);
    card.style.setProperty('--tilt', tilt + 'deg');

    var html = '<span class="pin" aria-hidden="true"></span>';
    var fileIds = item.fileIds || [];

    if (fileIds.length) {
      html += '<div class="card-media' + (fileIds.length > 1 ? ' multi' : '') + '">';
      fileIds.slice(0, 4).forEach(function (fid, i) {
        html += '<img loading="lazy" data-fileid="' + escapeHtml(fid) + '" alt="" ' +
          (i === 3 && fileIds.length > 4 ? 'data-more="+' + (fileIds.length - 4) + '"' : '') + '>';
      });
      html += '</div>';
    }
    if (item.text) html += '<p class="card-text">' + escapeHtml(item.text).replace(/\n/g, '<br>') + '</p>';
    html += '<div class="card-meta"><span class="card-time">' + escapeHtml(timeAgo(item.time)) + '</span></div>';

    card.innerHTML = html;

    // 图片按需换直链(只解析真正渲染出来的这些,不会一次性把全部历史都换一遍)
    $all('img[data-fileid]', card).forEach(function (img) {
      var fid = img.getAttribute('data-fileid');
      resolveFileUrl(fid, function (url) { img.src = url; }, function () { img.alt = '图片加载失败'; });
    });

    return card;
  }

  function renderMore(catId) {
    var s = state[catId];
    if (s.loading) return;
    var next = s.allItems.slice(s.shown, s.shown + CFG.pageSize);
    if (next.length === 0) return;
    var feed = $('#feed');
    var frag = document.createDocumentFragment();
    next.forEach(function (item) { frag.appendChild(createCard(item)); });
    feed.appendChild(frag);
    s.shown += next.length;
    if (s.shown >= s.allItems.length && s.allItems.length === 0) showEmptyState();
  }

  function setLoadingUI(isLoading) { $('#loadingIndicator').style.display = isLoading ? 'flex' : 'none'; }

  function showEmptyState() {
    var feed = $('#feed');
    if ($('.empty-state', feed)) return;
    var div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = '<p>这里还空着。</p><p class="empty-sub">来发第一条内容吧。</p>';
    feed.appendChild(div);
  }

  function loadCategory(catId) {
    var cat = getCat(catId);
    var s = state[catId];
    if (s.loading) return;
    s.loading = true;
    setLoadingUI(true);

    fetchPinnedIndexMessage(cat.chatId, function (pinnedMsg) {
      downloadIndexJson(pinnedMsg, function (indexObj) {
        s.allItems = (indexObj.items || []).slice().reverse(); // 新的在前
        s.shown = 0;
        s.loading = false;
        s.loaded = true;
        setLoadingUI(false);
        if (catId === currentCat) renderMore(catId);
      }, function (err) {
        s.loading = false; setLoadingUI(false);
        toast('索引读取失败:' + err.message, true);
      });
    }, function (err) {
      s.loading = false; setLoadingUI(false);
      toast('索引读取失败:' + err.message, true);
    });
  }

  function switchCategory(catId) {
    currentCat = catId;
    $all('.tab').forEach(function (t) {
      var active = t.getAttribute('data-cat') === catId;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('#feed').innerHTML = '';
    var s = state[catId];
    if (!s.loaded) { loadCategory(catId); return; }
    s.shown = 0;
    renderMore(catId);
  }

  // ================= 无限滚动 =================

  function initInfiniteScroll() {
    var sentinel = $('#scrollSentinel');
    if (HAS_IO) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) renderMore(currentCat); });
      }, { rootMargin: '600px' }).observe(sentinel);
      return;
    }
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.setTimeout(function () {
        if (document.body.scrollHeight - (window.scrollY + window.innerHeight) < 800) renderMore(currentCat);
        ticking = false;
      }, 200);
    });
  }

  // ================= 发布 =================

  function sendContent(chatId, text, files, onOk, onFail) {
    if (files.length === 0) {
      var fd = new FormData();
      fd.append('chat_id', chatId);
      fd.append('text', text.slice(0, 4096));
      tgPost('sendMessage', fd, function (msg) { onOk(msg.message_id, []); }, onFail);
      return;
    }
    if (files.length === 1) {
      var fd1 = new FormData();
      fd1.append('chat_id', chatId);
      if (text) fd1.append('caption', text.slice(0, 1024));
      fd1.append('photo', files[0]);
      tgPost('sendPhoto', fd1, function (msg) { onOk(msg.message_id, [msg.photo[msg.photo.length - 1].file_id]); }, onFail);
      return;
    }
    var fdN = new FormData();
    fdN.append('chat_id', chatId);
    var media = files.map(function (f, i) {
      var item = { type: 'photo', media: 'attach://file' + i };
      if (i === 0 && text) item.caption = text.slice(0, 1024);
      return item;
    });
    fdN.append('media', JSON.stringify(media));
    files.forEach(function (f, i) { fdN.append('file' + i, f); });
    tgPost('sendMediaGroup', fdN, function (msgs) {
      var fileIds = msgs.map(function (m) { return m.photo[m.photo.length - 1].file_id; });
      onOk(msgs[0].message_id, fileIds);
    }, onFail);
  }

  function publish(catId, text, files, onDone) {
    var cat = getCat(catId);
    sendContent(cat.chatId, text, files, function (mid, fileIds) {
      var entry = { id: cat.chatId + '_' + mid, mid: mid, fileIds: fileIds, text: text, time: new Date().toISOString() };
      appendToIndex(cat.chatId, function (items) { items.push(entry); return items; }, function (err) {
        onDone(err, entry);
      });
    }, function (err) { onDone(err, null); });
  }

  // ================= 发布表单交互 =================

  function initPublishForm() {
    var form = $('#publishForm');
    var textArea = $('#publishText');
    var fileInput = $('#publishFiles');
    var preview = $('#filePreview');
    var submitBtn = $('#publishSubmit');
    var catSelect = $('#publishCategory');

    CFG.categories.forEach(function (cat) {
      var opt = document.createElement('option');
      opt.value = cat.id; opt.textContent = cat.name;
      catSelect.appendChild(opt);
    });

    var pickedFiles = [];

    fileInput.addEventListener('change', function () {
      var incoming = Array.prototype.slice.call(fileInput.files || []);
      pickedFiles = incoming.slice(0, CFG.maxImagesPerPost);
      preview.innerHTML = '';
      pickedFiles.forEach(function (f) {
        var img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        preview.appendChild(img);
      });
      if (incoming.length > CFG.maxImagesPerPost) toast('最多选 ' + CFG.maxImagesPerPost + ' 张,多的已自动忽略', true);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = textArea.value.trim();
      if (!text && pickedFiles.length === 0) { toast('至少写点文字或选一张图', true); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = '发布中…';

      publish(catSelect.value, text, pickedFiles, function (err, entry) {
        submitBtn.disabled = false;
        submitBtn.textContent = '发布';
        if (err) { toast('发布失败:' + err.message, true); return; }
        toast('发布成功');

        var s = state[catSelect.value];
        if (s.loaded) { s.allItems.unshift(entry); }
        if (catSelect.value === currentCat) {
          var card = createCard(entry);
          var feed = $('#feed');
          if (feed.firstChild) feed.insertBefore(card, feed.firstChild); else feed.appendChild(card);
          s.shown += 1;
        }

        textArea.value = '';
        pickedFiles = [];
        preview.innerHTML = '';
        fileInput.value = '';
        var es = $('.empty-state'); if (es) es.remove();
      });
    });
  }

  // ================= 启动 =================

  function initTabs() {
    var tabBar = $('#tabBar');
    CFG.categories.forEach(function (cat, i) {
      var btn = document.createElement('button');
      btn.className = 'tab' + (i === 0 ? ' active' : '');
      btn.textContent = cat.name;
      btn.setAttribute('data-cat', cat.id);
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      btn.addEventListener('click', function () { switchCategory(cat.id); });
      tabBar.appendChild(btn);
    });
  }

  function checkConfig() {
    var bad = CFG.botToken === '8360783760:AAH6XJ-BUv59XOuj4_k-QOI2jV3RgMy6dv4' || CFG.categories.some(function (c) { return !c.chatId; });
    if (bad) { toast('还没配置 config.js 里的 botToken / 群组 chatId,页面先展示界面骨架', true); return false; }
    return true;
  }

  document.addEventListener('DOMContentLoaded', function () {
    initTabs();
    initPublishForm();
    initInfiniteScroll();
    if (checkConfig()) loadCategory(currentCat);
    else showEmptyState();
  });
})();
