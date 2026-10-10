/**
 * Tom de Voz IA — Main Application Logic
 *
 * Verbal brand-identity engine. One BYOK OpenRouter key (Hard Rule #1/#19) →
 * a structured Voice Guide (JSON), a deterministically-assembled portable Voice
 * Prompt, and a live rewriter. Everything renders/exports client-side; the only
 * backend is the shared n8n gate/webhooks. No Supabase in the browser.
 */
const App = (function () {
  'use strict';

  // ── slot names (COR-025: never `*KEY = '<hyphenated literal>'`) ──
  var VOICE_STORE = 'tom_de_voz_voices';
  var CURRENT_SLOT = 'tom_de_voz_current';

  var PERSONALITY = [
    'Próxima e calorosa', 'Ousada e provocadora', 'Séria e técnica',
    'Divertida e leve', 'Premium e sofisticada', 'Inspiradora e motivacional',
    'Direta e objetiva', 'Acolhedora e empática', 'Jovem e descolada',
    'Confiável e institucional', 'Criativa e artística', 'Minimalista e elegante'
  ];

  var state = { guide: null, brief: null, wired: false };

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._tm); t._tm = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // COR-015: normalise null-like LLM strings before rendering optional fields
  function clean(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/a|na|-|—|none|nenhum|nenhuma)$/i.test(s)) return '';
    return s;
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  function setupTabs() {
    var tabs = document.querySelectorAll('.tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('on'); });
        tab.classList.add('on');
        document.querySelectorAll('.tabpane').forEach(function (p) { p.classList.remove('on'); });
        var pane = $('pane-' + tab.getAttribute('data-tab'));
        if (pane) pane.classList.add('on');
      });
    });
  }

  function gotoTab(name) {
    var tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.click();
  }

  // ── Personality chips + counters ────────────────────────────────────────
  function renderChips() {
    var wrap = $('personality-chips'); if (!wrap) return;
    wrap.innerHTML = '';
    PERSONALITY.forEach(function (p) {
      var c = document.createElement('div');
      c.className = 'chip'; c.textContent = p; c.setAttribute('role', 'button'); c.tabIndex = 0;
      c.addEventListener('click', function () { c.classList.toggle('on'); });
      c.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.classList.toggle('on'); } });
      wrap.appendChild(c);
    });
  }

  function wireCounter(inputId, countId, max) {
    var el = $(inputId), ct = $(countId); if (!el || !ct) return;
    function upd() { ct.textContent = (el.value || '').length + ' / ' + max; }
    el.addEventListener('input', upd); upd();
  }

  function selectedPersonality() {
    return Array.prototype.slice.call(document.querySelectorAll('#personality-chips .chip.on'))
      .map(function (c) { return c.textContent; });
  }

  function collectBrief() {
    return {
      brand: ($('in-brand').value || '').trim(),
      niche: ($('in-niche').value || '').trim(),
      audience: ($('in-audience').value || '').trim(),
      personality: selectedPersonality(),
      refs: ($('in-refs').value || '').trim()
    };
  }

  // ── LLM ──────────────────────────────────────────────────────────────────
  function activeKey() {
    var k = window.ApiKeyManager && ApiKeyManager.getActiveKey ? ApiKeyManager.getActiveKey() : null;
    return k && k.key ? k : null;
  }

  // fetchContent: one OpenRouter call → returns the assistant message content (string).
  // Throws { emptyContent:true } when the model answered with empty content (COR-035).
  function fetchContent(messages, temperature, noReasoning) {
    var key = activeKey();
    if (!key) return Promise.reject(new Error('NO_KEY'));
    var model = (window.ApiKeyManager && ApiKeyManager.getModel) ? ApiKeyManager.getModel() : 'google/gemini-2.5-flash';
    var isDeepSeek = model.indexOf('deepseek/') === 0;
    var body = { model: model, messages: messages, temperature: (temperature == null ? 0.7 : temperature), max_tokens: 16000 };
    // COR-034/035: cap reasoning on OpenRouter, but NEVER for deepseek/*
    if (!isDeepSeek && !noReasoning) body.reasoning = { effort: 'low' };

    var doFetch = function () {
      return fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key.key,
          'Content-Type': 'application/json',
          'HTTP-Referer': location.origin,
          'X-Title': 'Tom de Voz IA'
        },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok) {
            var msg = 'Erro ' + r.status;
            try { var j = JSON.parse(txt); msg = (j.error && (j.error.message || j.error)) || msg; } catch (e) {}
            if (r.status === 401) msg = 'Chave inválida ou sem permissão. Confira sua chave da OpenRouter.';
            else if (r.status === 402) msg = 'Créditos insuficientes na sua conta OpenRouter.';
            else if (r.status === 429) msg = 'Muitas requisições. Aguarde alguns segundos e tente de novo.';
            var e = new Error(msg); e.httpStatus = r.status; throw e;
          }
          var data = JSON.parse(txt);
          var choice = (data.choices && data.choices[0]) || {};
          var content = (choice.message && choice.message.content) || '';
          if (!content || !String(content).trim()) { var em = new Error('Resposta vazia do modelo.'); em.emptyContent = true; throw em; }
          return String(content);
        });
      });
    };

    var run = function () {
      return doFetch().catch(function (e) {
        // empty-content retry net (COR-035): retry once WITHOUT reasoning
        if (e && e.emptyContent && !noReasoning) {
          body.reasoning = undefined; delete body.reasoning;
          return doFetch();
        }
        throw e;
      });
    };

    if (window.RateLimiter && RateLimiter.executeWithLimit) {
      return RateLimiter.executeWithLimit('openrouter', run);
    }
    return run();
  }

  // ── JSON repair ladder + reroll (COR-032) ─────────────────────────────────
  function stripToObject(s) {
    s = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
    return s;
  }
  function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function parseJSONLadder(raw) {
    var s = stripToObject(raw);
    var o = tryParse(s); if (o) return o;
    // trailing commas
    var s2 = s.replace(/,\s*([}\]])/g, '$1'); o = tryParse(s2); if (o) return o;
    // strip raw control chars (\xNN escape TEXT — never literal bytes, COR-041)
    var s3 = s2.replace(/[\x00-\x1f]+/g, ' '); o = tryParse(s3); if (o) return o;
    // smart quotes → straight
    var s4 = s3.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); o = tryParse(s4); if (o) return o;
    return null;
  }

  function callJSON(messages) {
    return fetchContent(messages, 0.7, false).then(function (txt) {
      var obj = parseJSONLadder(txt);
      if (obj) return obj;
      // reroll ONCE: stricter + lower temp (COR-032)
      var strict = messages.concat([{
        role: 'user',
        content: 'Sua resposta anterior NÃO era um JSON válido. Responda novamente APENAS com o objeto JSON pedido, com aspas retas ("), sem markdown, sem comentários, sem texto antes ou depois.'
      }]);
      return fetchContent(strict, 0.4, false).then(function (txt2) {
        var obj2 = parseJSONLadder(txt2);
        if (obj2) return obj2;
        throw new Error('O modelo não devolveu um JSON válido. Tente gerar novamente.');
      });
    });
  }

  // ── Prompts ────────────────────────────────────────────────────────────────
  var LANG_RULE = 'Escreva SEMPRE 100% em português do Brasil, com acentuação correta, SEM nenhuma palavra ou expressão em inglês (aceite apenas termos de marketing já consagrados em pt-BR como post, feed, Reels, Stories, lead).';

  function guideMessages(b) {
    var sys = 'Você é um estrategista de BRANDING VERBAL (tom de voz / identidade verbal) sênior, especialista em marcas brasileiras. ' +
      'Dada a descrição de uma marca, você projeta a IDENTIDADE VERBAL completa dela. ' + LANG_RULE + ' ' +
      'Responda EXCLUSIVAMENTE com um objeto JSON válido (sem markdown, sem texto fora do JSON), exatamente neste formato:\n' +
      '{\n' +
      '  "marca": "nome da marca",\n' +
      '  "essencia": "UMA frase que captura a essência da voz (como a marca soa em uma linha)",\n' +
      '  "amostra": "UMA frase de exemplo ESCRITA na voz da marca, como ela realmente falaria com o público (a amostra de voz)",\n' +
      '  "tracos": [ {"traco":"Adjetivo positivo","oposto":"não o exagero/vício correspondente","descricao":"1 frase explicando o traço na prática"} ],  // 4 a 5 itens\n' +
      '  "pilares": ["pilar de mensagem 1", "pilar 2", "pilar 3"],  // 3 temas que a marca sempre reforça\n' +
      '  "espectro": [ {"eixo":"Formal ↔ Casual","esquerda":"Formal","direita":"Casual","valor":65,"nota":"1 frase"} ],  // EXATAMENTE 5 eixos; valor 0-100 (0=totalmente à esquerda, 100=totalmente à direita). Use os eixos: Formal↔Casual, Sério↔Divertido, Técnico↔Simples, Reservado↔Caloroso, Clássico↔Ousado\n' +
      '  "lexico": {"usa":["palavra/expressão que a marca USA"], "evita":["palavra/expressão que a marca EVITA"]},  // 6 a 10 em cada\n' +
      '  "estilo": {"pessoa":"1ª do plural (nós) / 2ª (você) ...","formalidade":"...","emojis":"usa quais / não usa","girias":"...","frases":"curtas / médias ...","pontuacao":"..."},\n' +
      '  "canais": [ {"canal":"Instagram","como":"como a voz se adapta nesse canal"}, {"canal":"E-mail","como":"..."}, {"canal":"LinkedIn","como":"..."}, {"canal":"WhatsApp","como":"..."}, {"canal":"Site/Página","como":"..."} ],\n' +
      '  "exemplos": [ {"contexto":"Anúncio de produto","antes":"frase genérica/sem graça","depois":"a MESMA mensagem reescrita na voz da marca"} ]  // EXATAMENTE 3, contextos diferentes\n' +
      '}\n' +
      'Seja específico e concreto para ESTA marca — nada de clichês vagos. Os exemplos "antes" devem ser genéricos propositalmente, e os "depois" devem soar inconfundivelmente como a marca.';

    var u = 'Marca: ' + (b.brand || '(sem nome)') + '\n' +
      'Nicho/segmento: ' + (b.niche || '(não informado)') + '\n' +
      'Público: ' + (b.audience || '(não informado)') + '\n' +
      'Personalidade desejada: ' + (b.personality.length ? b.personality.join(', ') : '(não informada — você decide a mais adequada ao nicho)') + '\n' +
      'Referências de voz: ' + (b.refs || '(nenhuma)');

    return [{ role: 'system', content: sys }, { role: 'user', content: u }];
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  function showGuideState(which) {
    ['guide-empty', 'guide-loading', 'guide-output'].forEach(function (id) { $(id).hidden = (id !== which); });
    $('guide-error').hidden = true;
  }

  function generate() {
    if (!activeKey()) {
      toast('Conecte sua chave da OpenRouter primeiro.');
      var mb = $('manage-keys-btn'); if (mb) mb.click();
      return;
    }
    var b = collectBrief();
    if (!b.brand && !b.niche) { toast('Informe ao menos o nome ou o nicho da marca.'); return; }
    state.brief = b;
    gotoTab('guide');
    showGuideState('guide-loading');
    var btn = $('generate-btn'); btn.disabled = true;

    callJSON(guideMessages(b)).then(function (g) {
      g.marca = clean(g.marca) || b.brand || 'Sua marca';
      state.guide = g;
      renderGuide(g);
      buildPrompt(g);
      unlockRewriter(g);
      saveVoice(g, b);
      showGuideState('guide-output');
      toast('Voz criada ✓');
    }).catch(function (e) {
      showGuideState('guide-empty');
      var box = $('guide-error'); box.hidden = false;
      box.textContent = (e && e.message) ? e.message : 'Não foi possível gerar. Tente novamente.';
    }).then(function () { btn.disabled = false; });
  }

  // ── Render guide ─────────────────────────────────────────────────────────
  function renderGuide(g) {
    var card = $('guide-card');
    var parts = [];
    parts.push('<p class="g-eyebrow">Guia de Tom de Voz</p>');
    parts.push('<h2 class="g-brand">' + esc(g.marca) + '</h2>');
    if (clean(g.essencia)) parts.push('<p class="g-essence">' + esc(clean(g.essencia)) + '</p>');
    if (clean(g.amostra)) parts.push('<div class="g-sample"><span class="g-sample-tag">A marca soa assim</span>“' + esc(clean(g.amostra)) + '”</div>');

    // Traços
    if (Array.isArray(g.tracos) && g.tracos.length) {
      var t = g.tracos.map(function (x) {
        return '<div class="g-trait"><div class="t-name">' + esc(clean(x.traco)) +
          (clean(x.oposto) ? ' <span class="t-opp">— não ' + esc(clean(x.oposto).replace(/^não\s+/i, '')) + '</span>' : '') +
          '</div>' + (clean(x.descricao) ? '<div class="t-desc">' + esc(clean(x.descricao)) + '</div>' : '') + '</div>';
      }).join('');
      parts.push('<div class="g-section"><h3>Traços de personalidade</h3><div class="g-traits">' + t + '</div></div>');
    }

    // Pilares
    if (Array.isArray(g.pilares) && g.pilares.length) {
      var p = g.pilares.map(function (x, i) {
        return '<div class="g-pillar"><span class="p-num">' + (i + 1) + '</span>' + esc(clean(x)) + '</div>';
      }).join('');
      parts.push('<div class="g-section"><h3>Pilares de mensagem</h3><div class="g-pillars">' + p + '</div></div>');
    }

    // Espectro de tom (signature)
    if (Array.isArray(g.espectro) && g.espectro.length) {
      var sp = g.espectro.map(function (x) {
        var val = Math.max(0, Math.min(100, parseFloat(x.valor)));
        if (isNaN(val)) val = 50;
        return '<div class="g-spectrum"><div class="sp-head"><span>' + esc(clean(x.esquerda) || 'A') +
          '</span><span>' + esc(clean(x.direita) || 'B') + '</span></div>' +
          '<div class="sp-track"><span class="sp-drop" style="left:' + val + '%"></span></div>' +
          (clean(x.nota) ? '<div class="sp-note">' + esc(clean(x.nota)) + '</div>' : '') + '</div>';
      }).join('');
      parts.push('<div class="g-section"><h3>Mapa de tom</h3><div class="g-spectrums">' + sp + '</div></div>');
    }

    // Léxico
    if (g.lexico && (g.lexico.usa || g.lexico.evita)) {
      var usa = (g.lexico.usa || []).map(function (w) { return '<li>' + esc(clean(w)) + '</li>'; }).join('');
      var evita = (g.lexico.evita || []).map(function (w) { return '<li>' + esc(clean(w)) + '</li>'; }).join('');
      parts.push('<div class="g-section"><h3>Léxico da marca</h3><div class="g-lex">' +
        '<div class="lex-col lex-usa"><h4>Usa</h4><ul>' + usa + '</ul></div>' +
        '<div class="lex-col lex-evita"><h4>Evita</h4><ul>' + evita + '</ul></div></div></div>');
    }

    // Régua por canal
    if (Array.isArray(g.canais) && g.canais.length) {
      var ch = g.canais.map(function (x) {
        return '<div class="g-channel"><div class="ch-name">' + esc(clean(x.canal)) + '</div><div class="ch-how">' + esc(clean(x.como)) + '</div></div>';
      }).join('');
      parts.push('<div class="g-section"><h3>Régua de tom por canal</h3><div class="g-channels">' + ch + '</div></div>');
    }

    // Exemplos antes/depois
    if (Array.isArray(g.exemplos) && g.exemplos.length) {
      var ex = g.exemplos.map(function (x) {
        return '<div class="g-example"><div class="ex-ctx">' + esc(clean(x.contexto) || 'Exemplo') + '</div><div class="ex-pair">' +
          '<div class="ex-card ex-antes"><span class="ex-lbl">Antes</span>' + esc(clean(x.antes)) + '</div>' +
          '<div class="ex-card ex-depois"><span class="ex-lbl">Na voz da marca</span>' + esc(clean(x.depois)) + '</div>' +
          '</div></div>';
      }).join('');
      parts.push('<div class="g-section"><h3>Antes → Depois</h3><div class="g-examples">' + ex + '</div></div>');
    }

    // Estilo
    if (g.estilo && typeof g.estilo === 'object') {
      var labels = { pessoa: 'Pessoa', formalidade: 'Formalidade', emojis: 'Emojis', girias: 'Gírias', frases: 'Tamanho de frase', pontuacao: 'Pontuação' };
      var st = Object.keys(labels).filter(function (k) { return clean(g.estilo[k]); }).map(function (k) {
        return '<div class="st-item"><div class="st-k">' + labels[k] + '</div><div class="st-v">' + esc(clean(g.estilo[k])) + '</div></div>';
      }).join('');
      if (st) parts.push('<div class="g-section"><h3>Regras de estilo</h3><div class="g-style">' + st + '</div></div>');
    }

    parts.push('<div class="g-foot"><span>Tom de Voz IA · Maestros da IA</span><span>' + new Date().toLocaleDateString('pt-BR') + '</span></div>');
    card.innerHTML = parts.join('');
  }

  // ── Portable Voice Prompt (deterministic assembly — the moat) ──────────────
  function buildPrompt(g) {
    var L = [];
    L.push('Você vai escrever SEMPRE na voz da marca "' + (g.marca || 'minha marca') + '". Siga este guia de tom de voz em tudo que escrever:');
    L.push('');
    if (clean(g.essencia)) L.push('ESSÊNCIA DA VOZ: ' + clean(g.essencia));
    if (clean(g.amostra)) L.push('EXEMPLO DE COMO A MARCA SOA: "' + clean(g.amostra) + '"');
    L.push('');
    if (Array.isArray(g.tracos) && g.tracos.length) {
      L.push('TRAÇOS DE PERSONALIDADE:');
      g.tracos.forEach(function (t) {
        var line = '- ' + clean(t.traco);
        if (clean(t.oposto)) line += ' (mas nunca ' + clean(t.oposto).replace(/^não\s+/i, '') + ')';
        if (clean(t.descricao)) line += ': ' + clean(t.descricao);
        L.push(line);
      });
      L.push('');
    }
    if (Array.isArray(g.pilares) && g.pilares.length) {
      L.push('PILARES DE MENSAGEM (sempre reforce quando fizer sentido): ' + g.pilares.map(clean).filter(Boolean).join(' · '));
      L.push('');
    }
    if (g.lexico) {
      if (g.lexico.usa && g.lexico.usa.length) L.push('PALAVRAS/EXPRESSÕES QUE A MARCA USA: ' + g.lexico.usa.map(clean).filter(Boolean).join(', '));
      if (g.lexico.evita && g.lexico.evita.length) L.push('PALAVRAS/EXPRESSÕES QUE A MARCA EVITA (nunca use): ' + g.lexico.evita.map(clean).filter(Boolean).join(', '));
      L.push('');
    }
    if (g.estilo) {
      var e = g.estilo, s = [];
      if (clean(e.pessoa)) s.push('pessoa: ' + clean(e.pessoa));
      if (clean(e.formalidade)) s.push('formalidade: ' + clean(e.formalidade));
      if (clean(e.frases)) s.push('frases: ' + clean(e.frases));
      if (clean(e.emojis)) s.push('emojis: ' + clean(e.emojis));
      if (clean(e.girias)) s.push('gírias: ' + clean(e.girias));
      if (clean(e.pontuacao)) s.push('pontuação: ' + clean(e.pontuacao));
      if (s.length) { L.push('REGRAS DE ESTILO: ' + s.join('; ') + '.'); L.push(''); }
    }
    if (Array.isArray(g.espectro) && g.espectro.length) {
      L.push('POSICIONAMENTO DE TOM: ' + g.espectro.map(function (x) {
        var v = parseFloat(x.valor); if (isNaN(v)) v = 50;
        var side = v < 40 ? clean(x.esquerda) : (v > 60 ? clean(x.direita) : 'equilíbrio entre ' + clean(x.esquerda) + ' e ' + clean(x.direita));
        return side;
      }).filter(Boolean).join(', ') + '.');
      L.push('');
    }
    L.push('Ao escrever: mantenha a mensagem pedida, mas aplique sempre esta voz. Responda em português do Brasil. Agora, aguarde meu pedido e escreva na voz da marca.');
    var text = L.join('\n');
    $('prompt-box').textContent = text;
    $('prompt-empty').hidden = true;
    $('prompt-output').hidden = false;
    state.promptText = text;
    // mark the prompt tab as ready
    var pt = document.querySelector('.tab[data-tab="prompt"]');
    if (pt && !pt.querySelector('.dot')) { var d = document.createElement('span'); d.className = 'dot'; pt.appendChild(d); }
  }

  // ── Rewriter ────────────────────────────────────────────────────────────
  function unlockRewriter(g) {
    $('rewrite-locked').hidden = true;
    $('rewrite-output').hidden = false;
    var nm = $('rw-brand-name'); if (nm) nm.textContent = g.marca || 'sua marca';
  }

  function rewrite() {
    var g = state.guide;
    if (!g) { toast('Gere um Guia de Voz primeiro.'); return; }
    var input = ($('rw-input').value || '').trim();
    if (!input) { toast('Cole um texto para reescrever.'); return; }
    if (!activeKey()) { toast('Conecte sua chave da OpenRouter.'); return; }
    var canal = $('rw-channel').value;
    var btn = $('rewrite-btn'); btn.disabled = true;
    $('rewrite-err').hidden = true;
    $('rewrite-result').hidden = true;
    var old = btn.textContent; btn.textContent = 'Reescrevendo…';

    var sys = 'Você é redator da marca "' + (g.marca || '') + '" e reescreve textos na VOZ dela. ' + LANG_RULE +
      ' Reescreva o texto do usuário aplicando o guia de voz abaixo e adequando ao canal indicado. ' +
      'Mantenha a intenção e os fatos do texto original — NÃO invente dados, preços, datas ou promessas. ' +
      'Responda APENAS com o texto reescrito, sem comentários, sem aspas em volta, sem explicação.\n\n' +
      'GUIA DE VOZ:\n' + (state.promptText || JSON.stringify(g));

    var usr = 'CANAL: ' + canal + '\n\nTEXTO PARA REESCREVER NA VOZ DA MARCA:\n' + input;

    fetchContent([{ role: 'system', content: sys }, { role: 'user', content: usr }], 0.7, false)
      .then(function (out) {
        var clean2 = String(out).trim().replace(/^["“']|["”']$/g, '');
        $('rw-before').textContent = input;
        $('rw-after').textContent = clean2;
        $('rewrite-result').hidden = false;
      }).catch(function (e) {
        var box = $('rewrite-err'); box.hidden = false;
        box.textContent = (e && e.message) ? e.message : 'Não foi possível reescrever. Tente novamente.';
      }).then(function () { btn.disabled = false; btn.textContent = old; });
  }

  // ── Library (localStorage) ────────────────────────────────────────────────
  function loadVoices() { try { return JSON.parse(localStorage.getItem(VOICE_STORE) || '[]'); } catch (e) { return []; } }
  function storeVoices(v) { try { localStorage.setItem(VOICE_STORE, JSON.stringify(v.slice(0, 40))); } catch (e) {} }

  function saveVoice(g, b) {
    var voices = loadVoices();
    var id = 'v' + Date.now();
    voices.unshift({ id: id, marca: g.marca || (b && b.brand) || 'Sem nome', at: Date.now(), guide: g, brief: b });
    storeVoices(voices);
    try { localStorage.setItem(CURRENT_SLOT, id); } catch (e) {}
    renderLibrary(); renderVoiceSelect();
  }

  function renderLibrary() {
    var voices = loadVoices();
    var list = $('library-list'), empty = $('library-empty');
    if (!voices.length) { list.hidden = true; empty.hidden = false; return; }
    empty.hidden = true; list.hidden = false;
    list.innerHTML = voices.map(function (v) {
      var d = new Date(v.at);
      return '<div class="lib-item" data-id="' + v.id + '">' +
        '<div><div class="li-name">' + esc(v.marca) + '</div>' +
        '<div class="li-meta">' + d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '</div></div>' +
        '<div class="li-actions"><button class="btn-secondary" data-act="open">Abrir</button>' +
        '<button class="btn-danger" data-act="del">Excluir</button></div></div>';
    }).join('');
    list.querySelectorAll('.lib-item').forEach(function (row) {
      var id = row.getAttribute('data-id');
      row.querySelector('[data-act="open"]').addEventListener('click', function () { openVoice(id); });
      row.querySelector('[data-act="del"]').addEventListener('click', function () { deleteVoice(id); });
    });
  }

  function renderVoiceSelect() {
    var voices = loadVoices();
    var bar = $('voicebar'), sel = $('voice-select');
    if (!bar || !sel) return;
    if (voices.length < 1) { bar.hidden = true; return; }
    bar.hidden = false;
    var cur = '';
    try { cur = localStorage.getItem(CURRENT_SLOT) || ''; } catch (e) {}
    sel.innerHTML = voices.map(function (v) {
      return '<option value="' + v.id + '"' + (v.id === cur ? ' selected' : '') + '>' + esc(v.marca) + '</option>';
    }).join('');
    sel.onchange = function () { openVoice(sel.value); };
  }

  function openVoice(id) {
    var v = loadVoices().filter(function (x) { return x.id === id; })[0];
    if (!v) return;
    state.guide = v.guide; state.brief = v.brief || null;
    try { localStorage.setItem(CURRENT_SLOT, id); } catch (e) {}
    // refill brief into the rail
    if (v.brief) {
      $('in-brand').value = v.brief.brand || '';
      $('in-niche').value = v.brief.niche || '';
      $('in-audience').value = v.brief.audience || '';
      $('in-refs').value = v.brief.refs || '';
      document.querySelectorAll('#personality-chips .chip').forEach(function (c) {
        c.classList.toggle('on', (v.brief.personality || []).indexOf(c.textContent) !== -1);
      });
      wireCounter('in-refs', 'refs-count', 1200);
    }
    renderGuide(v.guide); buildPrompt(v.guide); unlockRewriter(v.guide);
    showGuideState('guide-output'); renderVoiceSelect();
    gotoTab('guide'); toast('Voz "' + (v.marca) + '" aberta');
  }

  function deleteVoice(id) {
    var voices = loadVoices().filter(function (x) { return x.id !== id; });
    storeVoices(voices); renderLibrary(); renderVoiceSelect();
    toast('Voz excluída');
  }

  // ── Exports ───────────────────────────────────────────────────────────────
  function guideToMarkdown(g) {
    var L = [];
    L.push('# Guia de Tom de Voz — ' + (g.marca || ''));
    if (clean(g.essencia)) L.push('\n> ' + clean(g.essencia));
    if (clean(g.amostra)) L.push('\n**A marca soa assim:** “' + clean(g.amostra) + '”');
    if (Array.isArray(g.tracos) && g.tracos.length) {
      L.push('\n## Traços de personalidade');
      g.tracos.forEach(function (t) { L.push('- **' + clean(t.traco) + '**' + (clean(t.oposto) ? ' (não ' + clean(t.oposto).replace(/^não\s+/i, '') + ')' : '') + (clean(t.descricao) ? ' — ' + clean(t.descricao) : '')); });
    }
    if (Array.isArray(g.pilares) && g.pilares.length) { L.push('\n## Pilares de mensagem'); g.pilares.forEach(function (p, i) { L.push((i + 1) + '. ' + clean(p)); }); }
    if (Array.isArray(g.espectro) && g.espectro.length) {
      L.push('\n## Mapa de tom');
      g.espectro.forEach(function (x) { var v = parseFloat(x.valor); if (isNaN(v)) v = 50; L.push('- ' + clean(x.esquerda) + ' ' + Math.round(v) + '% ' + clean(x.direita) + (clean(x.nota) ? ' — ' + clean(x.nota) : '')); });
    }
    if (g.lexico) {
      L.push('\n## Léxico');
      if (g.lexico.usa) L.push('**Usa:** ' + (g.lexico.usa || []).map(clean).filter(Boolean).join(', '));
      if (g.lexico.evita) L.push('**Evita:** ' + (g.lexico.evita || []).map(clean).filter(Boolean).join(', '));
    }
    if (Array.isArray(g.canais) && g.canais.length) { L.push('\n## Régua de tom por canal'); g.canais.forEach(function (c) { L.push('- **' + clean(c.canal) + ':** ' + clean(c.como)); }); }
    if (Array.isArray(g.exemplos) && g.exemplos.length) {
      L.push('\n## Antes → Depois');
      g.exemplos.forEach(function (x) { L.push('\n**' + clean(x.contexto) + '**'); L.push('- Antes: ' + clean(x.antes)); L.push('- Depois: ' + clean(x.depois)); });
    }
    if (g.estilo) {
      var labels = { pessoa: 'Pessoa', formalidade: 'Formalidade', emojis: 'Emojis', girias: 'Gírias', frases: 'Tamanho de frase', pontuacao: 'Pontuação' };
      var st = Object.keys(labels).filter(function (k) { return clean(g.estilo[k]); });
      if (st.length) { L.push('\n## Regras de estilo'); st.forEach(function (k) { L.push('- **' + labels[k] + ':** ' + clean(g.estilo[k])); }); }
    }
    return L.join('\n');
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || 'Copiado ✓'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else { legacyCopy(text); done(); }
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta);
  }
  function downloadFile(name, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob); var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  // PNG via SVG foreignObject (COR-045: single-quoted font-families in inline styles)
  function exportPNG() {
    var g = state.guide; if (!g) { toast('Gere um Guia primeiro.'); return; }
    toast('Gerando PNG…');
    var W = 900;
    var node = document.createElement('div');
    node.innerHTML = buildExportHTML(g);
    node.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + W + 'px;';
    document.body.appendChild(node);
    var inner = node.firstChild;
    var H = Math.ceil(inner.getBoundingClientRect().height) + 2;
    var xml = new XMLSerializer().serializeToString(inner);
    document.body.removeChild(node);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' +
      '<foreignObject width="100%" height="100%">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">' + xml + '</div></foreignObject></svg>';
    var img = new Image();
    var scale = 2;
    img.onload = function () {
      var c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale;
      var ctx = c.getContext('2d'); ctx.scale(scale, scale);
      ctx.fillStyle = '#f4efe3'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0);
      try {
        var data = c.toDataURL('image/png');
        var a = document.createElement('a'); a.href = data; a.download = 'tom-de-voz-' + slug(g.marca) + '.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        toast('PNG baixado ✓');
      } catch (e) { toast('Não foi possível gerar o PNG. Use Baixar PDF.'); }
    };
    img.onerror = function () { toast('Não foi possível gerar o PNG. Use Baixar PDF.'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function slug(s) { return String(s || 'marca').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'marca'; }

  // Self-contained export HTML (system fonts, single-quoted — COR-045)
  function buildExportHTML(g) {
    var SERIF = "Georgia,'Times New Roman',serif";
    var SANS = "'Helvetica Neue',Arial,sans-serif";
    var MONO = "'Courier New',monospace";
    var INK = '#141b24', INKS = '#52616e', INKD = '#7c8893', PEA = '#0b7285', RULE = '#d9cdb3';
    function row(label, html) { return '<div style="margin:0 0 22px"><div style="font-family:' + MONO + ';font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:' + INKS + ';border-bottom:1px solid ' + RULE + ';padding-bottom:6px;margin-bottom:12px">' + label + '</div>' + html + '</div>'; }
    var h = [];
    h.push('<div style="box-sizing:border-box;width:900px;background:#f4efe3;color:' + INK + ';font-family:' + SANS + ';padding:44px 48px;line-height:1.5">');
    h.push('<div style="font-family:' + MONO + ';font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:' + PEA + '">Guia de Tom de Voz</div>');
    h.push('<div style="font-family:' + SERIF + ';font-size:34px;font-weight:700;margin:4px 0 18px">' + esc(g.marca) + '</div>');
    if (clean(g.essencia)) h.push('<div style="font-family:' + SERIF + ';font-style:italic;font-size:24px;line-height:1.35;border-left:3px solid ' + PEA + ';padding-left:18px;margin-bottom:22px">' + esc(clean(g.essencia)) + '</div>');
    if (clean(g.amostra)) h.push('<div style="background:#fffdf7;border:1px solid ' + RULE + ';border-radius:8px;padding:16px 18px;margin-bottom:26px;font-family:' + SERIF + ';font-size:17px;color:#2a2016">“' + esc(clean(g.amostra)) + '”</div>');
    if (Array.isArray(g.tracos) && g.tracos.length) {
      h.push(row('Traços de personalidade', g.tracos.map(function (t) {
        return '<div style="margin-bottom:8px"><b style="color:' + INK + '">' + esc(clean(t.traco)) + '</b>' + (clean(t.oposto) ? ' <span style="color:#a8431f;font-size:13px">— não ' + esc(clean(t.oposto).replace(/^não\s+/i, '')) + '</span>' : '') + (clean(t.descricao) ? '<div style="color:' + INKS + ';font-size:14px">' + esc(clean(t.descricao)) + '</div>' : '') + '</div>';
      }).join('')));
    }
    if (Array.isArray(g.pilares) && g.pilares.length) h.push(row('Pilares de mensagem', g.pilares.map(function (p, i) { return '<div style="margin-bottom:6px"><b style="color:' + PEA + '">' + (i + 1) + '.</b> ' + esc(clean(p)) + '</div>'; }).join('')));
    if (Array.isArray(g.espectro) && g.espectro.length) {
      h.push(row('Mapa de tom', g.espectro.map(function (x) {
        var v = parseFloat(x.valor); if (isNaN(v)) v = 50;
        return '<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px;color:' + INKS + ';margin-bottom:4px"><span>' + esc(clean(x.esquerda)) + '</span><span>' + esc(clean(x.direita)) + '</span></div>' +
          '<div style="position:relative;height:10px;border-radius:999px;background:linear-gradient(90deg,rgba(11,114,133,.2),rgba(140,123,255,.2));border:1px solid ' + RULE + '"><span style="position:absolute;top:-4px;left:' + v + '%;width:16px;height:16px;margin-left:-8px;background:' + PEA + ';border-radius:50%"></span></div></div>';
      }).join('')));
    }
    if (g.lexico) {
      var usa = (g.lexico.usa || []).map(clean).filter(Boolean).join(' · ');
      var evi = (g.lexico.evita || []).map(clean).filter(Boolean).join(' · ');
      h.push(row('Léxico da marca', '<div style="font-size:14px;margin-bottom:6px"><b style="color:#1d7a52">Usa:</b> ' + esc(usa) + '</div><div style="font-size:14px"><b style="color:#a8431f">Evita:</b> ' + esc(evi) + '</div>'));
    }
    if (Array.isArray(g.canais) && g.canais.length) h.push(row('Régua de tom por canal', g.canais.map(function (c) { return '<div style="margin-bottom:8px"><b>' + esc(clean(c.canal)) + ':</b> <span style="color:' + INKS + '">' + esc(clean(c.como)) + '</span></div>'; }).join('')));
    if (Array.isArray(g.exemplos) && g.exemplos.length) h.push(row('Antes → Depois', g.exemplos.map(function (x) { return '<div style="margin-bottom:12px"><div style="font-family:' + MONO + ';font-size:11px;text-transform:uppercase;color:' + INKD + ';margin-bottom:4px">' + esc(clean(x.contexto)) + '</div><div style="color:' + INKS + ';font-size:14px">Antes: ' + esc(clean(x.antes)) + '</div><div style="color:' + INK + ';font-size:14px;border-left:3px solid ' + PEA + ';padding-left:10px;margin-top:4px">Depois: ' + esc(clean(x.depois)) + '</div></div>'; }).join('')));
    if (g.estilo) {
      var labels = { pessoa: 'Pessoa', formalidade: 'Formalidade', emojis: 'Emojis', girias: 'Gírias', frases: 'Frase', pontuacao: 'Pontuação' };
      var st = Object.keys(labels).filter(function (k) { return clean(g.estilo[k]); }).map(function (k) { return '<div style="margin-bottom:6px;font-size:14px"><b style="color:' + INKD + '">' + labels[k] + ':</b> ' + esc(clean(g.estilo[k])) + '</div>'; }).join('');
      if (st) h.push(row('Regras de estilo', st));
    }
    h.push('<div style="margin-top:22px;padding-top:12px;border-top:1px solid ' + RULE + ';font-size:12px;color:' + INKD + '">Tom de Voz IA · Maestros da IA</div>');
    h.push('</div>');
    return h.join('');
  }

  // ── Example prefill ────────────────────────────────────────────────────────
  function prefillExample() {
    $('in-brand').value = 'Raiz & Rotina';
    $('in-niche').value = 'cafés especiais por assinatura';
    $('in-audience').value = 'adultos 25–45 que levam o ritual do café a sério, moram em cidade grande';
    $('in-refs').value = 'Gostamos de falar como quem serve um café pra um amigo: sem pompa, mas com repertório. Admiramos a forma como a Dengo e a Nespresso falam de prazer no dia a dia.';
    document.querySelectorAll('#personality-chips .chip').forEach(function (c) {
      c.classList.toggle('on', ['Próxima e calorosa', 'Premium e sofisticada', 'Inspiradora e motivacional'].indexOf(c.textContent) !== -1);
    });
    wireCounter('in-refs', 'refs-count', 1200);
    toast('Exemplo preenchido — gere o Guia');
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function init() {
    if (state.wired) { syncOnReady(); return; }
    state.wired = true;

    renderChips();
    setupTabs();
    wireCounter('in-refs', 'refs-count', 1200);
    wireCounter('rw-input', 'rw-count', 4000);
    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');

    $('generate-btn').addEventListener('click', generate);
    $('examples-btn').addEventListener('click', prefillExample);
    $('rewrite-btn').addEventListener('click', rewrite);

    $('dl-pdf').addEventListener('click', function () { window.print(); });
    $('dl-png').addEventListener('click', exportPNG);
    $('copy-md').addEventListener('click', function () { if (state.guide) copyText(guideToMarkdown(state.guide), 'Guia copiado (Markdown) ✓'); });
    $('copy-prompt').addEventListener('click', function () { if (state.promptText) copyText(state.promptText, 'Prompt de Voz copiado ✓'); });
    $('dl-prompt').addEventListener('click', function () { if (state.promptText) downloadFile('prompt-de-voz-' + slug(state.guide && state.guide.marca) + '.txt', state.promptText); });
    $('copy-rewrite').addEventListener('click', function () { copyText($('rw-after').textContent, 'Texto copiado ✓'); });

    // logout clears gate credentials (COR-062)
    var lo = $('logout-btn');
    if (lo) lo.addEventListener('click', function () {
      var em = $('gate-email'), ph = $('gate-phone'), er = $('gate-error');
      if (em) em.value = ''; if (ph) ph.value = ''; if (er) { er.textContent = ''; er.style.display = 'none'; }
    });

    renderLibrary(); renderVoiceSelect();
    syncOnReady();
  }

  // re-sync state that can change after init (COR-008)
  function syncOnReady() {
    var s = (window.MembershipGate && MembershipGate.getSession) ? MembershipGate.getSession() : null;
    // nothing member-specific to paint beyond greeting; library already rendered.
  }

  return { init: init };
})();

// ── App init triggers: event + DOMContentLoaded + MutationObserver (COR-044) ──
(function () {
  var started = false;
  function go() { if (started) return; started = true; App.init(); }
  document.addEventListener('maestria:app-ready', go);
  document.addEventListener('DOMContentLoaded', function () {
    var app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) { setTimeout(go, 100); }
    // MutationObserver: fire the moment #app-screen becomes active (COR-044)
    if (app) {
      var mo = new MutationObserver(function () { if (app.classList.contains('active')) go(); });
      mo.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
  });
})();
