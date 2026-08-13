// SillyTavern 扩展：暮蝶做的蜜月换衣间（已购衣物同步） (stand-in-honeymoon-sync)
// 需求：对话中购买「可购买衣物库」的衣物后，自动追加到独立的「已购衣物库」世界书条目。
// 定稿方案（见同目录 实现须知.md）：
//   - 已购衣物做成独立世界书条目（comment="已购衣物库"），与「已有衣物库」同等地位，不塞进 id12
//   - 编号是扩展记账标记（防重复/对账键）；林婉清与剧情NPC不知晓编号，剧情只用款式名
//   - 已购衣物库头部自带性质声明：不适用「已有衣物库」无色情约定，但延续「色情设定隐藏规则」
// 触发：购买动词 + 编号（用户/系统层）或 购买动词 + 款式名唯一匹配（剧情层），缺一不触发
// 防误判：试穿/只看不买/先不买 等强否定不触发；款式名歧义不触发
// 防越权：只新建/维护「已购衣物库」这一个条目，绝不碰可购买库、已有库和其他条目
// 容错：任何异常静默返回，不打断对话
// 设置面板：manifest.settings 指向 settings.html（扩展菜单抽屉）；含启用开关/状态/手动同步

(function () {
    'use strict';

    // 第三方扩展走动态 <script> 加载，不能用 ES import（会报 SyntaxError 导致 failed to load）
    // 一律从 SillyTavern 全局对象解构；个别字段旧版没挂全，带 window 兜底
    const _st = window.SillyTavern || {};
    const eventSource = _st.eventSource || window.eventSource;
    const event_types = _st.event_types || window.event_types;
    const getContext = _st.getContext || window.getContext;
    const saveCharacterDebounced = _st.saveCharacterDebounced || window.saveCharacterDebounced;

    const PREFIX = '[暮蝶换衣间]';
    const STORAGE_KEY_ENABLED = 'standInHoneyMoonSync_enabled_v1';
    // 已购库本地备份：v2 起含 content（无编号，模型可读）+ purchasedIds（编号记账集合，模型读不到）。
    // 云平台若保存不落盘，扩展每次加载从这恢复，保证模型能读到已购库、防重复对账有据。
    const STORAGE_KEY_BACKUP = 'standInHoneyMoonSync_backup_v2';
    // v1 备份（含编号的旧 content + 预置款式）一次性清除，避免 9 款默认衣服回灌。
    const STORAGE_KEY_BACKUP_V1 = 'standInHoneyMoonSync_backup_v1';
    const SETTINGS_EXTENSION_NAME = 'stand-in-honeymoon-sync';
    const SETTINGS_VERSION = '1.6.0';

    // 诊断记录（设置面板自检显示，不需要 F12 控制台）
    const diag = {
        lastSaveFound: [],   // 探测到的保存接口名
        lastSaveMethod: '',  // 实际调用到的保存接口
        lastSaveError: '',   // 保存抛错信息
        lastSaveAt: 0,
        lastAdded: '',       // 上次同步的款式
        lastSyncAt: 0,
        loadReapply: '',     // 最近一次加载恢复的结果
        charPath: '',        // 世界书来源路径
        eventCalls: 0,       // onMessage 被调次数（事件版本）
        lastEventType: '',   // 最近一次事件类型
        lastEventHadMsg: 0,  // 最近事件携带的消息条数
        recentMessages: [],  // 最近处理的原始消息（截断），自检里对它们跑匹配审计
        pollChecks: 0,       // 轮询检查次数
        pollHits: 0,         // 轮询发现聊天增长（抓到新消息）的次数
        pollAdded: '',       // 轮询累计追加的款式
        wiSynced: false,     // 是否成功同步进活跃世界书(context.worldInfo)
        targetIndex: -1,     // 目标角色在 characters 数组的下标
        charIdChar: '',      // characterId 指向的角色名
        editorSynced: false, // 是否同步进编辑器活动书(characterBook/settings.world_info)
        saveRequests: [],    // 抓到的平台保存/同步请求（fetch + XHR 拦截）
        wiTestResult: '',    // 写 worldInfo 落盘测试结果
        serverScan: '',      // 服务器世界书扫描结果（自检异步探测）
        serverScanAt: 0,
        serverWriteResult: '', // 已购库写入服务器世界书结果
    };

    // 轮询状态：事件系统不可靠（云平台可能不发 MESSAGE_RECEIVED），靠 chat.length 变化兜底。
    let pollTimer = null;
    let lastWatchKey = '';   // 上次记录的 (角色标识:聊天长度)，用于检测新消息
    function fmtTime(ts) {
        if (!ts) return '';
        try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { return String(ts); }
    }

    // --- 保存请求拦截（fetch + XHR） ---
    // 平台保存到底走哪条网络请求、响应啥，直接抓出来看，不猜。记录最近的写入类请求。
    function installRequestHook() {
        if (window.__sihsReqHook) return;
        window.__sihsReqHook = true;
        const record = (req) => {
            if (!req || !req.url) return;
            if (!/save|character|world|settings|chat|avatar|api/i.test(req.url)) return;
            if (req.method === 'GET') return; // 只抓写操作
            diag.saveRequests.push(req);
            if (diag.saveRequests.length > 30) diag.saveRequests.shift();
        };
        // fetch
        try {
            const origFetch = window.fetch;
            if (typeof origFetch === 'function') {
                window.fetch = function (...args) {
                    try {
                        const url = String(args[0] && args[0].url ? args[0].url : (args[0] || ''));
                        const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
                        const body = (args[1] && args[1].body) || (args[0] && args[0].body) || '';
                        record({ t: Date.now(), method, url, len: body ? String(body).length : 0 });
                    } catch (e) { /* ignore */ }
                    return origFetch.apply(this, args).then((r) => {
                        try {
                            const last = diag.saveRequests[diag.saveRequests.length - 1];
                            if (last && last.status === undefined) last.status = r.status;
                        } catch (e) { /* ignore */ }
                        return r;
                    });
                };
            }
        } catch (e) { /* ignore */ }
        // XHR
        try {
            const proto = XMLHttpRequest.prototype;
            const origOpen = proto.open;
            const origSend = proto.send;
            proto.open = function (method, url, ...rest) {
                this.__sihsUrl = url;
                this.__sihsMethod = method;
                return origOpen.call(this, method, url, ...rest);
            };
            proto.send = function (...args) {
                const self = this;
                if (this.__sihsUrl) {
                    const req = { t: Date.now(), method: this.__sihsMethod || 'GET', url: String(this.__sihsUrl), len: (args[0] ? String(args[0]).length : 0) };
                    try {
                        this.addEventListener('load', () => {
                            req.status = this.status;
                            record(req);
                        });
                    } catch (e) {
                        record(req);
                    }
                }
                return origSend.apply(this, args);
            };
        } catch (e) { /* ignore */ }
    }

    // --- 已购库本地备份（localStorage） ---
    // 结构：{ [角色名]: { content: <已购衣物库 content，无编号>, purchasedIds: [<泳03>,...], updatedAt: <ts> } }
    function loadBackup() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY_BACKUP)) || {}; } catch (e) { return {}; }
    }
    function saveBackup(map) {
        try { localStorage.setItem(STORAGE_KEY_BACKUP, JSON.stringify(map)); } catch (e) { /* ignore */ }
    }
    // 升级 v2：清掉 v1 旧备份（含编号 + 预置款式），避免旧数据回灌
    function migrateBackupV2() {
        try { localStorage.removeItem(STORAGE_KEY_BACKUP_V1); } catch (e) { /* ignore */ }
    }
    // 角色名键：云平台角色顶层 name 可能为 null，真名在 data.name，统一取第一个非空
    function charNameKey(char) {
        if (!char) return '';
        return char.name || (char.data && char.data.name) || '';
    }

    function backupFor(charName) {
        return loadBackup()[charName] || null;
    }
    function writeBackup(charName, content, purchasedIds) {
        const map = loadBackup();
        map[charName] = {
            content,
            purchasedIds: Array.isArray(purchasedIds) ? purchasedIds : [],
            updatedAt: Date.now(),
        };
        saveBackup(map);
    }
    function refreshBackup(charName, content, purchasedIds) {
        const map = loadBackup();
        const b = map[charName];
        const ids = Array.isArray(purchasedIds)
            ? purchasedIds
            : (b && Array.isArray(b.purchasedIds) ? b.purchasedIds : []);
        if (!b || b.content !== content) {
            map[charName] = { content, purchasedIds: ids, updatedAt: Date.now() };
            saveBackup(map);
        }
    }

    // 角色世界书解析：兼容不同平台/卡结构。
    // 标准 SillyTavern 处理后角色对象把 world 摊在顶层 character_book；
    // 部分 fork / v3 卡原样保留 data 包裹（data.character_book），甚至 extensions 包裹。
    // 返回 { cb, path }，path 供状态栏诊断显示命中的字段路径。
    function resolveCharBook(character) {
        if (!character) return { cb: null, path: '' };
        const pick = (o) => (o && o.character_book && Array.isArray(o.character_book.entries) ? o.character_book : null);
        if (pick(character)) return { cb: character.character_book, path: '顶层 character_book' };
        if (character.data && pick(character.data)) return { cb: character.data.character_book, path: 'data.character_book' };
        if (character.extensions && pick(character.extensions)) return { cb: character.extensions.character_book, path: 'extensions.character_book' };
        return { cb: null, path: '' };
    }

    // 可购买库分类汉字 → 分区标题（已购衣物库内的分区名）
    const CATEGORY_NAMES = {
        泳: '泳衣类',
        睡: '睡衣类',
        日: '日常类',
        内: '内衣类',
        礼: '礼服类',
    };

    // 编号匹配：分类汉字 + 两位数字。
    // 负向排除防误配：今日/每周/上周 的"日"、礼物/礼貌/衣/服 前的分类字（睡衣/内衣里的第一个"睡/内"）。
    function itemIdRe() {
        return new RegExp(
            '(?<![今每上周])([泳睡日内礼])(?!物|貌|堂|拜|帽|服|衣|前|装)\\s*(\\d{2})',
            'g',
        );
    }

    // 购买动词（含"买"兜底）
    const PURCHASE_VERB_RE = /(买了|买下|买单|购买|网购|下单|付款|结账|入手|挑中|选中|拿下|要了|买走|买到了|想买|要买|买)/;
    // 强否定：只看不买、先不买等，出现即不触发
    const NEGATIVE_BUY_RE = /(不买|别买|没买|没付款|只看不买|光看不买|先不买|不打算买)/;

    // 已购衣物库初始模板（分区 + 头部声明 + 编号认知）
    const PURCHASED_TEMPLATE = [
        '# 已购衣物库（剧情中购买获得的衣物清单）',
        '【定位】本条目记录角色在剧情中通过购物/购买流程获得的衣物，均来自「可购买衣物库」的已购款式。本条目衣物已在剧情中购买获得，可直接取用穿着，无需再走购买流程，与「已有衣物库」（出发时随行的既有衣物）相对。',
        '【已购转移豁免】本条目为已购衣物的【权威清单】：其中衣物已经明确购买并确认获得，不受「可购买衣物库」"未购买视为不存在""绝不允许直接穿着"等防误用约束的限制。',
        '【性质声明】本条目衣物来自「可购买衣物库」，保留其完整设定，包括色情款的【隐藏标记】【实际结构】【动态反应】等隐藏特性。本条目【不适用】「已有衣物库」头部"无色情特性"的约定。',
        '【色情设定隐藏规则延续】角色购买、入手本条目衣物时，仍不知晓其隐藏特性（走光、透明、滑落等）；此类特性只在实际穿着后，经动作或环境（风、水、卧姿、活动）作用时才逐步显现，角色此时略感意外，不会早有预料。规则与「可购买衣物库」完全一致。',
        '【编号认知】本条目衣物一律以款式名记录，内容中不出现编号。编号（泳/睡/日/内/礼 01-20）仅存在于扩展记账层，用于防重复与对账，不进入本条目内容，模型与剧情均读不到编号。林婉清及剧情产生的NPC均【不知晓】编号，剧情描写一律以款式名称呼衣物。',
        '',
        '## 泳衣类',
        '',
        '## 睡衣类',
        '',
        '## 日常类',
        '',
        '## 内衣类',
        '',
        '## 礼服类',
        '',
        '## 使用说明',
        '- 本条目由扩展自动维护：购买一件追加一件，只增不改不删。',
        '- 追加的款式整块保留原设定文本（款式外观/实际结构/动态反应/隐藏标记等），标题只保留款式名。',
        '- 编号仅存于扩展记账层，角色与剧情不知晓编号，剧情中只以款式名指代衣物。',
        '',
    ].join('\n');

    function log(...args) {
        console.log(PREFIX, ...args);
    }

    // 兼容多种聊天消息正文格式：标准 SillyTavern 用 mes（is_user 标记），部分平台用 message/content。
    function msgText(m) {
        if (!m) return '';
        if (typeof m.message === 'string') return m.message;
        if (typeof m.mes === 'string') return m.mes;
        if (typeof m.content === 'string') return m.content;
        return '';
    }

    // 提示条：优先 toastr，兜底 console
    function showToast(type, msg) {
        try {
            if (window.toastr && typeof window.toastr[type] === 'function') {
                window.toastr[type](msg, '暮蝶做的蜜月换衣间');
                return;
            }
        } catch (e) { /* ignore */ }
        log(msg);
    }

    // 扩展总开关（设置面板可切，localStorage 持久化）
    let extensionEnabled = true;
    function loadExtensionEnabled() {
        try {
            const v = localStorage.getItem(STORAGE_KEY_ENABLED);
            extensionEnabled = v === null ? true : v === 'true';
        } catch (e) {
            extensionEnabled = true;
        }
    }

    // 解析可购买库所有衣物块标题，供款式名匹配。
    // 返回 [{ cat, num, id, title }]（title 为编号之后的款式名）。
    function parseShelfTitles(shelfContent) {
        const result = [];
        if (!shelfContent) return result;
        const re = /(?:【非色情】[^\n]*)?([泳睡日内礼])【[泳睡日内礼](\d{2})】([^\n]+)/g;
        let m;
        while ((m = re.exec(shelfContent)) !== null) {
            const cat = m[1];
            if (!CATEGORY_NAMES[cat]) continue;
            result.push({
                cat,
                num: m[2],
                id: cat + m[2],
                title: m[3].trim(),
            });
        }
        return result;
    }

    // 归一化：去掉口语语气词/量词/助词，只留关键词用于包含匹配
    function normalizeForMatch(s) {
        return (s || '')
            .replace(/[的了啊呀呢吗吧嘛哦哈，。！？、\s·]/g, '')
            .replace(/那件|这件|这件|一条|一件|套|个|条|件|款|件套|吧|呀|呢/g, '');
    }

    // 解析单条消息的购买语境。返回 [{ cat, num, id, by }]（by: 'id' 编号命中 / 'title' 款式名命中）。
    // 三要素：购买动词存在 + 无强否定 + (编号 或 唯一款式名)。缺一返回空数组。
    function analyzeMessage(text, shelfTitles) {
        if (!text || typeof text !== 'string') return [];
        if (NEGATIVE_BUY_RE.test(text)) return [];
        if (!PURCHASE_VERB_RE.test(text)) return [];
        const result = [];
        const seen = new Set();

        // 路径1：编号命中（用户/系统层明确指定）
        const re = itemIdRe();
        let m;
        while ((m = re.exec(text)) !== null) {
            const cat = m[1];
            const num = m[2];
            const id = cat + num;
            if (!CATEGORY_NAMES[cat]) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            result.push({ cat, num, id, by: 'id' });
        }

        // 路径2：款式名唯一命中（剧情层只用款式名，编号不出现在角色认知中）
        if (result.length === 0 && Array.isArray(shelfTitles)) {
            const normMsg = normalizeForMatch(text);
            const candidates = [];
            for (const t of shelfTitles) {
                const normTitle = normalizeForMatch(t.title);
                if (normTitle.length < 4) continue; // 太短易误配
                if (normMsg.includes(normTitle)) candidates.push(t);
            }
            // 唯一候选才触发，歧义则放弃（安全优先）
            if (candidates.length === 1) {
                const c = candidates[0];
                if (!seen.has(c.id)) {
                    seen.add(c.id);
                    result.push({ cat: c.cat, num: c.num, id: c.id, by: 'title' });
                }
            } else if (candidates.length > 1) {
                log(`款式名命中多个候选（${candidates.map((c) => c.id).join(',')}），放弃避免误加`);
            }
        }

        return result;
    }

    // 从「可购买衣物库」content 里切出编号对应的整块衣物文本。
    // 块边界：下一个衣物块标题 或 下一个 ## 分区/章节标题 或条目结尾。
    function extractItemBlock(shelfContent, cat, num) {
        if (!shelfContent) return null;
        const id = cat + num;
        const startRe = new RegExp(`(?:【非色情】[^\\n]*)?${cat}【${id}】`);
        const sm = startRe.exec(shelfContent);
        if (!sm) return null;
        const startIdx = sm.index;
        const searchFrom = startIdx + sm[0].length;
        const endRe = new RegExp(
            '(?:【非色情】[^\\n]*)?[泳睡日内礼]【[泳睡日内礼]\\d{2}】|##\\s',
            'm',
        );
        const em = endRe.exec(shelfContent.slice(searchFrom));
        const endIdx = em ? searchFrom + em.index : shelfContent.length;
        const block = shelfContent.slice(startIdx, endIdx).trim();
        return block || null;
    }

    // 从块文本剥离编号标记「泳【泳03】」等，只留款式名与设定——模型永远读不到编号。
    function stripItemIds(block) {
        return (block || '').replace(/[泳睡日内礼]【[泳睡日内礼]\d{2}】/g, '');
    }

    // 已购衣物库是否已存在该编号（防重复）。编号集合记账于备份 purchasedIds，不依赖 content。
    function isAlreadyPurchased(purchasedIds, id) {
        return Array.isArray(purchasedIds) && purchasedIds.includes(id);
    }

    // 把衣物块追加进已购衣物库 content 对应分类小节（在「## 分类名」之后、下一分区之前）。
    function appendItem(purchasedContent, cat, block) {
        const sectionTitle = `## ${CATEGORY_NAMES[cat]}`;
        const si = purchasedContent.indexOf(sectionTitle);
        if (si === -1) return purchasedContent; // 找不到分区则不动，安全
        const after = purchasedContent.slice(si + sectionTitle.length);
        const nextSectionRe = /^##\s/m;
        const ns = nextSectionRe.exec(after);
        const insertAt = ns ? si + sectionTitle.length + ns.index : purchasedContent.length;
        const insertion = `${block}\n\n`;
        return purchasedContent.slice(0, insertAt) + insertion + purchasedContent.slice(insertAt);
    }

    // 找到带「可购买衣物库」条目的角色（优先当前选中角色）。
    function getTargetCharacter(context) {
        const chars = (context && context.characters) || [];
        const hasShelf = (c) => {
            const { cb } = resolveCharBook(c);
            return !!cb && cb.entries.some((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
        };
        const idx = (typeof context.characterId === 'number' || typeof context.characterId === 'string')
            ? Number(context.characterId) : -1;
        if (idx >= 0 && hasShelf(chars[idx])) return { char: chars[idx], index: idx };
        for (let i = 0; i < chars.length; i++) {
            if (hasShelf(chars[i])) return { char: chars[i], index: i };
        }
        return null;
    }

    // 照「已有衣物库」条目拷贝字段，新建「已购衣物库」条目。
    function buildNewPurchasedEntry(char, template) {
        const { cb } = resolveCharBook(char);
        if (!cb) return null;
        const model = cb.entries.find(
            (e) => e && e.comment && String(e.comment).includes('已有衣物库'),
        );
        const entry = {
            comment: '已购衣物库',
            content: template,
            constant: true,
            selective: true,
            insertion_order: 89, // 略大于已有衣物库(88)，排在它后面
            enabled: true,
            position: 'after_char',
            use_regex: true,
            keys: ['已购', '衣物', '购买', '购入'],
        };
        if (model) {
            // 拷贝其余字段，保证与酒馆世界书兼容
            const copyFields = [
                'extensions',
                'scan_depth',
                'case_sensitive',
                'match_whole_words',
                'use_group_scoring',
                'automation_id',
                'role',
                'vectorized',
                'sticky',
                'cooldown',
                'delay',
                'prevent_recursion',
                'delay_until_recursion',
            ];
            for (const k of copyFields) {
                if (model[k] !== undefined && entry[k] === undefined) {
                    entry[k] = model[k] && typeof model[k] === 'object'
                        ? JSON.parse(JSON.stringify(model[k]))
                        : model[k];
                }
            }
        }
        // display_index 给个大概率不冲突的值（编辑器里仅用于排序，重复也不崩）
        if (entry.extensions && typeof entry.extensions === 'object') {
            entry.extensions.display_index = 13;
        }
        cb.entries.push(entry);
        return entry;
    }

    // 同步「已购衣物库」到平台活跃世界书（context.worldInfo）。
    // 标准 SillyTavern 聊天激活的世界书条目数组，平台编辑器显示/保存的就是这份；
    // 扩展改 data.character_book 不落盘时，这份是真正落盘的路径。返回 true 表示已写入。
    function syncToActiveWorld(context, content) {
        if (!context || !Array.isArray(context.worldInfo)) return false;
        const hasShelf = context.worldInfo.some((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
        if (!hasShelf) return false; // worldInfo 不是代替蜜月角色世界书，不动
        let entry = context.worldInfo.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
        if (!entry) {
            // 仿照「已有衣物库」/「可购买衣物库」条目字段新建，然后 push 进 worldInfo
            const fakeChar = { character_book: { entries: context.worldInfo } };
            const built = buildNewPurchasedEntry(fakeChar, content);
            if (!built) return false;
            // world info 条目常见带 uid（编辑器/保存依赖），给个不冲突的值
            let maxUid = -1;
            for (const e of context.worldInfo) {
                if (e && typeof e.uid === 'number' && e.uid > maxUid) maxUid = e.uid;
            }
            if (built.uid === undefined) built.uid = maxUid + 1;
            entry = built;
        }
        entry.content = content;
        if (typeof context.saveWorldInfo === 'function') {
            try { context.saveWorldInfo(); } catch (e) { log('saveWorldInfo 失败：', e); }
        }
        return true;
    }

    // 同步到平台世界书"编辑器活动书"：context.characterBook（ST 编辑器当前打开的角色书）
    // 与 settings.world_info / window.world_info（全局世界书列表，角色书可能被挂进来）。
    // 标准 ST 编辑器打开角色书后改的是活动副本；若平台编辑器读的是这份而非 data.character_book，
    // 这里补写，保证已打开的编辑器能立即看到。全部防御式，找不到就跳过。
    function syncToEditorState(context, content) {
        if (!context) return false;
        let touched = 0;
        const setEntry = (entriesArr) => {
            if (!Array.isArray(entriesArr)) return false;
            const hasShelf = entriesArr.some((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
            if (!hasShelf) return false; // 不是代替蜜月的角色世界书，不动
            let entry = entriesArr.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
            if (!entry) {
                const fakeChar = { character_book: { entries: entriesArr } };
                const built = buildNewPurchasedEntry(fakeChar, content);
                if (!built) return false;
                let maxUid = -1;
                for (const e of entriesArr) {
                    if (e && typeof e.uid === 'number' && e.uid > maxUid) maxUid = e.uid;
                }
                if (built.uid === undefined) built.uid = maxUid + 1;
                entry = built;
                entriesArr.push(entry);
            }
            entry.content = content;
            return true;
        };
        // 1) context.characterBook：编辑器当前打开的角色书
        const cb = context.characterBook;
        if (cb && Array.isArray(cb.entries) && setEntry(cb.entries)) touched++;
        // 2) 全局世界书列表：context.settings.world_info → window.world_info 兜底
        let wiList = (context.settings && Array.isArray(context.settings.world_info))
            ? context.settings.world_info : null;
        if (!wiList) {
            try { if (Array.isArray(window.world_info)) wiList = window.world_info; } catch (e) { /* ignore */ }
        }
        if (Array.isArray(wiList)) {
            for (const book of wiList) {
                if (book && Array.isArray(book.entries) && setEntry(book.entries)) touched++;
            }
        }
        return touched > 0;
    }

    // --- 轮询兜底：云平台事件系统可能不触发 MESSAGE_RECEIVED，靠 chat.length 变化捕获新消息 ---
    // 只分析"新增"的消息，不重扫历史。事件照常监听（双保险），轮询是兜底。
    function watchChat() {
        diag.pollChecks++;
        if (!extensionEnabled) return;
        const c = getContext();
        if (!c || !Array.isArray(c.chat)) return;
        const id = c.characterId;
        const key = String(id) + ':' + c.chat.length;
        if (!lastWatchKey) {
            lastWatchKey = key; // 首次只记录基线，不分析历史
            return;
        }
        const sep = lastWatchKey.lastIndexOf(':');
        const lastId = lastWatchKey.slice(0, sep);
        const lastLen = parseInt(lastWatchKey.slice(sep + 1), 10) || 0;
        if (String(id) !== lastId) {
            lastWatchKey = key; // 切角色，重置基线
            return;
        }
        if (c.chat.length > lastLen) {
            const newMsgs = c.chat.slice(lastLen);
            lastWatchKey = key;
            diag.pollHits++;
            diag.pollAdded = '';
            handleMessages(newMsgs, true);
            if (diag.pollAdded) log('轮询捕获新消息并同步: ' + diag.pollAdded);
        } else if (c.chat.length < lastLen) {
            lastWatchKey = key; // 聊天被清空/切换，重置基线
        }
    }

    function startPolling() {
        if (pollTimer) return;
        try {
            pollTimer = setInterval(watchChat, 1500);
        } catch (e) {
            log('轮询启动失败：', e);
        }
    }

    function handleMessages(messages, fromPoll) {
        if (!extensionEnabled) return; // 设置里关了总开关则跳过
        const context = getContext();
        if (!context) return;
        const target = getTargetCharacter(context);
        if (!target) return;
        const { char, index } = target;
        const { cb, path } = resolveCharBook(char);
        if (!cb) return;
        const entries = cb.entries;

        const shelf = entries.find((e) => e.comment && e.comment.includes('可购买衣物库'));
        if (!shelf) return; // 没有货架条目，静默返回
        const shelfTitles = parseShelfTitles(shelf.content);

        // 找到或创建「已购衣物库」条目（唯一操作对象）
        let purchasedEntry = entries.find((e) => e.comment && e.comment.includes('已购衣物库'));
        if (!purchasedEntry) {
            purchasedEntry = buildNewPurchasedEntry(char, PURCHASED_TEMPLATE);
            log('创建「已购衣物库」条目');
        }

        let content = purchasedEntry.content || '';
        // 已购编号记账集合：来自本地备份（唯一权威），防重复对账用；模型读不到（不进 content）
        const b0 = backupFor(charNameKey(char));
        let purchasedIds = (b0 && Array.isArray(b0.purchasedIds)) ? b0.purchasedIds.slice() : [];
        let changed = false;
        const added = [];

        for (const msg of messages) {
            const mtext = msgText(msg);
            if (!mtext) continue;
            const buys = analyzeMessage(mtext, shelfTitles);
            for (const b of buys) {
                if (isAlreadyPurchased(purchasedIds, b.id)) {
                    log(`跳过重复：${b.id}`);
                    continue;
                }
                const block = extractItemBlock(shelf.content, b.cat, b.num);
                if (!block) {
                    log(`在可购买库找不到 ${b.id} 的完整设定，跳过`);
                    continue;
                }
                // 关键：剥离编号后再进已购库，角色/剧情永远看不到编号
                const cleanBlock = stripItemIds(block);
                if (!cleanBlock) continue;
                content = appendItem(content, b.cat, cleanBlock);
                purchasedIds.push(b.id);
                changed = true;
                added.push(`${b.id}(${b.by === 'title' ? '款式名' : '编号'})`);
            }
        }

        if (!changed) {
            // 没新增款式也提示，方便确认"点同步"确实执行过（避免以为按钮没反应）
            if (fromPoll) { /* 轮询静默 */ } else {
                log('同步检查完成：无新增购买');
            }
            return;
        }
        purchasedEntry.content = content;

        diag.lastAdded = added.join('、');
        diag.lastSyncAt = Date.now();
        diag.charPath = path;
        if (fromPoll) diag.pollAdded = added.join('、');
        writeBackup(charNameKey(char), content, purchasedIds); // 无论平台是否落盘，本地备份先存
        // 关键：同步到活跃世界书（context.worldInfo）——平台编辑器真正读写的存储
        diag.wiSynced = syncToActiveWorld(context, content);
        if (diag.wiSynced) log('已同步进活跃世界书（context.worldInfo）');
        diag.editorSynced = syncToEditorState(context, content);
        if (diag.editorSynced) log('已同步进编辑器活动书（characterBook/settings.world_info）');

        // 保存：把所有候选保存接口全开火（谁真正落盘谁负责），不因单个成功短路。
        if (!saveCharacterSafe(context, index, char)) {
            log('保存角色失败：找不到可用的保存接口（本地备份已存，下次加载自动恢复）');
            showToast('warning', '自动保存失败：已存本地备份，下次打开自动恢复已购库');
        } else {
            log(`已购衣物已同步：${added.join('、')}（已触发保存：${diag.lastSaveMethod}）`);
        }
    }

    // 多路保存：云平台可能把角色数据存进不同子系统，且"调用不抛错"不代表"落盘了"。
    // 策略：能调的全调（fire-and-forget），不短路——saveMetadata* 存角色 data（character_book 在里面），
    // saveWorldInfo 存世界书系统，saveCharacter* 是标准酒馆接口，全部触发，谁真正落盘谁负责。
    // 记录诊断：存在哪些接口、实际调了哪些、是否抛错。
    function saveCharacterSafe(context, index, char) {
        diag.lastSaveFound = [];
        diag.lastSaveError = '';
        const attempts = [];
        // 1) context 上所有候选保存方法（无参变体，保存当前角色/数据）
        const ctxKeys = [
            'saveMetadataDebounced', 'saveMetadata',       // 角色 data（character_book 所在）
            'saveWorldInfo',                               // 平台世界书系统
            'saveSettingsDebounced',                       // 平台设置（可能连带角色）
            'saveCharacterDebounced', 'saveCharacter', 'saveCharacterCard', 'saveCharacterSettings',
        ];
        for (const k of ctxKeys) {
            if (context && typeof context[k] === 'function') {
                attempts.push(['context.' + k, () => context[k]()]);
            }
        }
        // 2) window / SillyTavern 全局保存方法（带参：index, char）
        const globals = ['saveCharacterDebounced', 'saveCharacter', 'saveCharacterCard'];
        for (const k of globals) {
            const f1 = window.SillyTavern && typeof window.SillyTavern[k] === 'function' ? window.SillyTavern[k] : null;
            const f2 = typeof window[k] === 'function' ? window[k] : null;
            const fn = f1 || f2;
            if (fn) attempts.push(['window.' + k, () => fn(index, char)]);
        }
        diag.lastSaveFound = attempts.map((a) => a[0]);
        // 全部开火，逐个 try/catch，不因某个成功就跳过其余
        const called = [];
        for (const [name, fn] of attempts) {
            try {
                fn();
                called.push(name);
            } catch (e) {
                diag.lastSaveError = name + ': ' + (e && e.message);
            }
        }
        if (called.length) {
            diag.lastSaveMethod = called.join(' + ');
            diag.lastSaveAt = Date.now();
            return true;
        }
        diag.lastSaveMethod = '';
        return false; // 一个候选都没有 → 由上层提示（本地备份兜底）
    }

    // 加载时恢复：若平台没把已购库持久化（常见于云酒馆），从本地备份重新注入内存，
    // 保证本次会话的模型能读到已购衣物库。若平台已持久化（内存里有条目），以平台版本为准并刷新备份。
    // 返回 true 表示完成（无论是否恢复）；返回 false 表示还没准备好（无角色/无世界书），由调用方重试。
    function reapplyOnLoad() {
        try {
            const context = getContext();
            if (!context) { diag.loadReapply = 'getContext 不可用'; return false; }
            const target = getTargetCharacter(context);
            if (!target) { diag.loadReapply = '未找到目标角色'; return false; }
            const { char } = target;
            const { cb, path } = resolveCharBook(char);
            if (!cb) { diag.loadReapply = '未找到世界书'; return false; }
            diag.charPath = path;
            const entries = cb.entries;
            const existing = entries.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
            const b = backupFor(charNameKey(char));
            const backupIds = (b && Array.isArray(b.purchasedIds)) ? b.purchasedIds.slice() : [];
            const restoreContent = (c) => {
                // 恢复动作：写内存 + 同步进活跃世界书/编辑器活动书 + 保存
                if (Array.isArray(context.worldInfo) &&
                    context.worldInfo.some((e) => e && e.comment && String(e.comment).includes('可购买衣物库'))) {
                    diag.wiSynced = syncToActiveWorld(context, c) || diag.wiSynced;
                }
                diag.editorSynced = syncToEditorState(context, c) || diag.editorSynced;
                saveCharacterSafe(context, target.index, char);
            };
            if (existing) {
                // 旧格式迁移：条目 content 若含编号标记（旧版/预置卡遗留），剥离编号并收回记账集合
                const legacyIds = (existing.content || '').match(/[泳睡日内礼]【[泳睡日内礼]\d{2}】/g);
                if (legacyIds && legacyIds.length) {
                    const ids = legacyIds.map((x) => x.replace(/【|】/g, '').slice(0, 3));
                    const merged = Array.from(new Set([...backupIds, ...ids]));
                    existing.content = stripItemIds(existing.content);
                    refreshBackup(charNameKey(char), existing.content, merged);
                    diag.loadReapply = `迁移旧格式已购库（剥离编号，记账 ${merged.length} 款）`;
                    restoreContent(existing.content);
                    return true;
                }
                if (backupIds.length) {
                    existing.content = b.content;
                    diag.loadReapply = `从备份覆盖恢复已购衣物库（${backupIds.length} 款）`;
                    restoreContent(existing.content);
                    return true;
                }
                // 备份空：条目为空白模板，保持干净，只刷新备份
                refreshBackup(charNameKey(char), existing.content, []);
                diag.loadReapply = '内存已有已购衣物库（空白模板，无已购记录）';
                return true;
            }
            if (b && b.content) {
                const entry = buildNewPurchasedEntry(char, b.content);
                if (entry) {
                    diag.loadReapply = `从本地备份恢复已购衣物库（${backupIds.length} 款）`;
                    log('从本地备份恢复「已购衣物库」条目');
                    restoreContent(entry.content);
                    return true;
                }
                diag.loadReapply = '备份存在但重建条目失败';
            } else {
                diag.loadReapply = '无备份可恢复（正常，尚未购买）';
            }
            return true;
        } catch (e) {
            diag.loadReapply = '异常: ' + (e && e.message);
            return false;
        }
    }

    function onMessage(...args) {
        diag.eventCalls++;
        let messages = [];
        const chatArg = args[0];
        if (Array.isArray(chatArg) && chatArg.length) {
            const idArg = args[1];
            const idx =
                typeof idArg === 'number' && idArg >= 0 ? idArg : chatArg.length - 1;
            messages = chatArg.slice(Math.max(0, idx - 3), idx + 1);
            diag.lastEventHadMsg = messages.length;
        } else {
            const c = getContext();
            if (c && Array.isArray(c.chat)) messages = c.chat.slice(-3);
            diag.lastEventHadMsg = messages.length;
        }
        diag.recentMessages = messages.slice(-5).map((m) => ({
            role: m && (m.role || (m.is_user ? 'user' : m.name || '?')),
            text: msgText(m).slice(0, 100),
        }));
        try {
            handleMessages(messages);
        } catch (e) {
            log('处理消息出错（已静默）：', e);
        }
    }

    // --- 设置面板（扩展菜单抽屉） ---

    function getSettingsPanel() {
        return document.querySelector(
            `[data-extension-name="${SETTINGS_EXTENSION_NAME}"]`,
        );
    }

    // 自动渲染兜底：SillyTavern 正常情况下会按 manifest.settings 把 settings.html
    // 渲染进扩展菜单抽屉；若托管平台没渲染，则手动注入 #extensions_settings2。
    function ensureSettingsPanel() {
        if (getSettingsPanel()) return;
        try {
            const host = document.querySelector('#extensions_settings2');
            if (!host) return;
            if (host.querySelector(`[data-extension-name="${SETTINGS_EXTENSION_NAME}"]`)) return;
            const urls = [
                `/extensions/${SETTINGS_EXTENSION_NAME}/settings.html`,
                `/scripts/extensions/third-party/${SETTINGS_EXTENSION_NAME}/settings.html`,
            ];
            let i = 0;
            const tryFetch = () => {
                if (i >= urls.length) return;
                fetch(urls[i])
                    .then((r) => (r.ok ? r.text() : Promise.reject(new Error('not found'))))
                    .then((html) => {
                        if (getSettingsPanel()) return;
                        host.insertAdjacentHTML('beforeend', html);
                        bindSettingsPanel();
                    })
                    .catch(() => { i++; tryFetch(); });
            };
            tryFetch();
        } catch (e) { /* ignore */ }
    }

    // 面板渲染时机不定，轮询等它出现后绑定（最多约 10 秒）
    function initSettingsPanel() {
        let tries = 0;
        const poll = () => {
            const panel = getSettingsPanel();
            if (panel) {
                bindSettingsPanel();
                return;
            }
            if (tries++ < 20) {
                setTimeout(poll, 500);
            } else {
                // 自动渲染一直没出现 → 手动兜底注入
                ensureSettingsPanel();
            }
        };
        setTimeout(poll, 300);
    }

    function bindSettingsPanel() {
        const panel = getSettingsPanel();
        if (!panel || panel.dataset.bound) return;
        panel.dataset.bound = '1';

        const $cb = panel.querySelector('#sihs-enabled-checkbox');
        if ($cb) {
            $cb.checked = extensionEnabled;
            $cb.addEventListener('change', () => {
                extensionEnabled = $cb.checked;
                try {
                    localStorage.setItem(STORAGE_KEY_ENABLED, String(extensionEnabled));
                } catch (e) { /* ignore */ }
                showToast(extensionEnabled ? '已购衣物同步已启用' : '已购衣物同步已禁用');                updateSettingsStatus();
            });
        }

        const $sync = panel.querySelector('#sihs-force-sync');
        if ($sync) $sync.addEventListener('click', forceSyncNow);

        const $diag = panel.querySelector('#sihs-self-check');
        if ($diag) {
            $diag.addEventListener('click', async () => {
                const pre = panel.querySelector('#sihs-diag-pre');
                if (!pre) return;
                const text = await runSelfCheck();
                pre.textContent = text;
                pre.style.display = 'block';
                showToast('info', '自检完成，结果已显示（复制发给暮蝶）');
            });
        }

        const $testSave = panel.querySelector('#sihs-test-save');
        if ($testSave) {
            $testSave.addEventListener('click', testSaveNow);
        }

        const $writeWi = panel.querySelector('#sihs-write-worldinfo');
        if ($writeWi) {
            $writeWi.addEventListener('click', writeWorldInfoNow);
        }

        const $exportCard = panel.querySelector('#sihs-export-card');
        if ($exportCard) {
            $exportCard.addEventListener('click', exportCardNow);
        }

        const $writeServer = panel.querySelector('#sihs-write-server');
        if ($writeServer) {
            $writeServer.addEventListener('click', () => { writeServerWorldInfoNow(); });
        }

        const $gh = panel.querySelector('#sihs-open-github');
        if ($gh) {
            $gh.addEventListener('click', () => {
                window.open('https://github.com/ZFY1999/stand-in-honeymoon-sync', '_blank');
            });
        }

        const $ver = panel.querySelector('#sihs-version');
        if ($ver) $ver.textContent = SETTINGS_VERSION;

        updateSettingsStatus();
    }

    function updateSettingsStatus() {
        const panel = getSettingsPanel();
        if (!panel) return;
        const $disp = panel.querySelector('#sihs-status-display');
        if (!$disp) return;
        let text = '';
        try {
            const context = getContext();
            const target = getTargetCharacter(context);
            if (!target) {
                text = '未找到带「可购买衣物库」的角色（当前角色需是"代替蜜月"）。';
            } else {
                const { cb, path } = resolveCharBook(target.char);
                const entries = (cb && cb.entries) || [];
                const hasShelf = entries.some((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
                const hasPurchased = entries.some((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
                const b = backupFor(charNameKey(target.char));
                const n = (b && Array.isArray(b.purchasedIds)) ? b.purchasedIds.length : 0;
                text = `目标角色：${charNameKey(target.char) || '(无名)'}；已购衣物库：${hasPurchased ? '已创建' : '尚未创建'}（当前 ${n} 款）；世界书来源：${path || '未找到'}。`;
            }
        } catch (e) {
            text = '状态获取失败（不影响监听）。';
        }
        $disp.textContent = text;
    }

    function forceSyncNow() {
        if (!extensionEnabled) {
            showToast('warning', '扩展已禁用，请先在设置里启用。');
            return;
        }
        let messages = [];
        try {
            const c = getContext();
            if (c && Array.isArray(c.chat)) messages = c.chat.slice(-5);
        } catch (e) { /* ignore */ }
        const before = diag.lastAdded;
        handleMessages(messages);
        const after = diag.lastAdded;
        setTimeout(() => {
            updateSettingsStatus();
            showToast(after !== before ? 'info' : 'info', after !== before
                ? '已同步：' + after
                : '同步完成：无新增购买（点上方"运行自检"看详情）');
        }, 300);
    }

    // 测试保存：手动触发一次全量保存候选，报告哪些接口被调用（验证平台到底走哪条路落盘）
    function testSaveNow() {
        try {
            const c = getContext();
            if (!c) { showToast('warning', 'getContext 不可用'); return; }
            const t = getTargetCharacter(c);
            if (!t) { showToast('warning', '未找到目标角色'); return; }
            const ok = saveCharacterSafe(c, t.index, t.char);
            const called = diag.lastSaveMethod || '(无)';
            showToast(ok ? 'info' : 'warning', '已触发保存：' + called + (ok ? '' : '（未找到任何保存接口）'));
            setTimeout(updateSettingsStatus, 300);
            log('测试保存：调用 ' + called + '；探测到 ' + diag.lastSaveFound.join(', '));
        } catch (e) {
            showToast('error', '测试保存异常：' + (e && e.message));
        }
    }

    // 写 worldInfo 落盘测试：把已购衣物库条目直接塞进 context.worldInfo（若为数组）再 saveWorldInfo 落盘。
    // 平台自检显示 context 挂着真 saveWorldInfo 且抓包有 /api/worldinfo/edit → 试这条真落盘路。
    // 同时把 worldInfo 的类型/是否数组/可否新建/是否含可购买库全打出来，不用控制台也能看。
    function writeWorldInfoNow() {
        try {
            const c = getContext();
            if (!c) { showToast('warning', 'getContext 不可用'); return; }
            const t = getTargetCharacter(c);
            if (!t) { showToast('warning', '未找到目标角色'); return; }

            // 1) 找已购库 content（内存里的）
            const { cb } = resolveCharBook(t.char);
            if (!cb) { showToast('error', '目标角色无世界书 data.character_book'); return; }
            const pur = cb.entries.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
            if (!pur) { showToast('error', '内存里没有「已购衣物库」条目，先买一件或点立即同步'); return; }
            const content = pur.content;

            // 2) worldInfo 到底是啥
            const wiType = c.worldInfo === undefined ? 'undefined' : (Array.isArray(c.worldInfo) ? 'array' : typeof c.worldInfo);
            const lines = ['【写 worldInfo 落盘测试】', 'worldInfo 类型: ' + wiType];
            if (c.worldInfo !== undefined && !Array.isArray(c.worldInfo)) {
                try {
                    const ks = Object.keys(c.worldInfo || {});
                    lines.push('worldInfo 对象键: ' + (ks.length ? ks.join(', ') : '(空)'));
                } catch (e) { /* ignore */ }
            }
            if (Array.isArray(c.worldInfo)) {
                lines.push('worldInfo 数组长度: ' + c.worldInfo.length);
                const hasShelf = c.worldInfo.some((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
                const hasPur = c.worldInfo.some((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
                lines.push('worldInfo 含可购买库: ' + (hasShelf ? '是' : '否'));
                lines.push('worldInfo 含已购库: ' + (hasPur ? '是' : '否'));
                if (!hasShelf && !hasPur) {
                    // worldInfo 不是代替蜜月的书 → 尝试按"通用书"写入？不，防御：提示别乱写别人的书
                    lines.push('worldInfo 不含可购买库，不是代替蜜月的角色书 → 不写入，避免污染别的书');
                    writeWorldInfoResult(lines);
                    return;
                }
            }

            // 3) 塞进去
            let wrote = false;
            if (Array.isArray(c.worldInfo)) {
                // 复用 syncToActiveWorld（写条目 + 调 saveWorldInfo）
                wrote = syncToActiveWorld(c, content);
            } else if (c.worldInfo && typeof c.worldInfo === 'object') {
                // 对象形态：找 entries / data
                const arrCandidates = [c.worldInfo.entries, c.worldInfo.data, c.worldInfo.world_info];
                for (const arr of arrCandidates) {
                    if (Array.isArray(arr) && arr.some((e) => e && e.comment && String(e.comment).includes('可购买衣物库'))) {
                        const fakeChar = { character_book: { entries: arr } };
                        const built = buildNewPurchasedEntry(fakeChar, content);
                        if (built) {
                            arr.push(built);
                            wrote = true;
                            break;
                        }
                    }
                }
                if (!wrote) lines.push('worldInfo 对象里找不到可购买库条目数组，未写入');
            }
            lines.push('写入 worldInfo: ' + (wrote ? '成功' : '未执行'));

            // 4) 落盘
            if (wrote) {
                const saveNames = ['saveWorldInfo', 'saveMetadataDebounced', 'saveMetadata', 'saveSettingsDebounced'];
                const called = [];
                for (const n of saveNames) {
                    try { if (typeof c[n] === 'function') { c[n](); called.push(n); } } catch (e) { /* ignore */ }
                }
                lines.push('已触发落盘: ' + (called.length ? called.join(' + ') : '(无可用保存函数)'));
            }
            writeWorldInfoResult(lines);
        } catch (e) {
            showToast('error', '写 worldInfo 异常：' + (e && e.message));
        }
    }

    function writeWorldInfoResult(lines) {
        lines.push('（以上结果已存入自检，点「运行自检」也能看到）');
        diag.wiTestResult = lines.join('\n');
        showToast('info', '写 worldInfo 落盘测试完成，结果已显示');
        log(lines.join('\n'));
        try {
            const panel = getSettingsPanel();
            if (panel) {
                const pre = panel.querySelector('#sihs-diag-pre');
                if (pre) {
                    pre.textContent = lines.join('\n');
                    pre.style.display = 'block';
                }
            }
        } catch (e) { /* ignore */ }
    }

    // --- 服务器世界书 API（从 AutoCardUpdater 学来的真落盘路） ---
    // 之前抓包确认：平台编辑器保存世界书就是 POST /api/worldinfo/edit (status=200)。
    // AutoCardUpdater 能改世界书且改动可见，全靠这条原生 API。暮蝶直接抄它。
    async function serverApi(method, path, body) {
        let headers = { 'Content-Type': 'application/json' };
        try {
            const ctx = getContext();
            // 取请求头：优先顶层 getRequestHeaders（本云平台挂在 getContext 顶层），
            // 再试标准酒馆的 common.getRequestHeaders（带 CSRF token），都没有就只带 Content-Type。
            if (ctx && typeof ctx.getRequestHeaders === 'function') {
                headers = ctx.getRequestHeaders();
            } else if (ctx && ctx.common && typeof ctx.common.getRequestHeaders === 'function') {
                headers = ctx.common.getRequestHeaders();
            }
        } catch (e) { /* ignore */ }
        const opts = { method, headers };
        if (body !== undefined) opts.body = JSON.stringify(body);
        return await fetch('/api/worldinfo/' + path, opts);
    }

    // 拉全部世界书名字（GET /api/worldinfo/all）
    async function serverBookNames() {
        try {
            const res = await serverApi('GET', 'all');
            if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
            const data = await res.json().catch(() => null);
            const list = data && (data.data || data.world_info);
            if (!Array.isArray(list)) return { ok: true, names: [] };
            return {
                ok: true,
                names: list
                    .map((b) => (typeof b === 'string' ? b : b && (b.name || b.id || '')))
                    .filter(Boolean),
            };
        } catch (e) {
            return { ok: false, err: String((e && e.message) || e) };
        }
    }

    // 读一本服务器书全部条目（GET /api/worldinfo/get?name=书）
    async function serverReadBook(name) {
        try {
            const res = await serverApi('GET', 'get?name=' + encodeURIComponent(name));
            if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
            const data = await res.json().catch(() => null);
            const entries = (data && (data.entries || data.data)) || [];
            return { ok: true, entries };
        } catch (e) {
            return { ok: false, err: String((e && e.message) || e) };
        }
    }

    // 找服务器上含「可购买衣物库」的世界书（遍历所有书逐个读，书不多可接受）
    async function findServerShelfBook() {
        const all = await serverBookNames();
        if (!all.ok) return { ok: false, err: all.err };
        const hasShelf = (e) => e && String((e.comment || '') + (e.name || '')).includes('可购买衣物库');
        for (const name of all.names) {
            try {
                const r = await serverReadBook(name);
                if (r.ok && r.entries.some(hasShelf)) {
                    return { ok: true, book: name, entries: r.entries };
                }
            } catch (e) { /* ignore */ }
        }
        return { ok: false, err: '服务器上没有找到含「可购买衣物库」的世界书（共 ' + all.names.length + ' 本）' };
    }

    // 按钮：把已购衣物库写到服务器世界书（POST /api/worldinfo/create 或 edit，写完整条目）
    async function writeServerWorldInfoNow() {
        const lines = ['【已购库写入服务器世界书】'];
        try {
            const c = getContext();
            const t = c ? getTargetCharacter(c) : null;
            if (!t) { lines.push('未找到目标角色'); writeServerResult(lines); return; }
            const { cb } = resolveCharBook(t.char);
            const pur = cb && cb.entries.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
            const b = backupFor(charNameKey(t.char));
            const content = (b && b.content) || (pur && pur.content);
            if (!content) { lines.push('没有已购库内容（先买一件，或点立即同步）'); writeServerResult(lines); return; }
            const ids = (b && Array.isArray(b.purchasedIds)) ? b.purchasedIds : [];
            const n = ids.length;
            lines.push('已购库 content ' + content.length + ' 字（无编号），' + n + ' 款');

            lines.push('探测服务器世界书...');
            const shelf = await findServerShelfBook();
            if (!shelf.ok) { lines.push('未找到目标书：' + shelf.err); writeServerResult(lines); return; }
            lines.push('命中服务器世界书: ' + shelf.book + '（' + shelf.entries.length + ' 条）');
            const shelfE = shelf.entries.find((e) => e && String((e.comment || '') + (e.name || '')).includes('可购买衣物库'));
            if (shelfE && shelfE.content) lines.push('服务器可购买库长度: ' + shelfE.content.length + ' 字');

            const existing = shelf.entries.find((e) => e && String((e.comment || '') + (e.name || '')).includes('已购衣物库'));
            // 条目：保留已有条目的其余字段（uid 等），只换 content
            const entry = Object.assign({}, existing || {}, {
                comment: '已购衣物库',
                content,
                keys: ['已购', '衣物', '购买', '购入'],
            });
            if (!existing) {
                const r = await serverApi('POST', 'create', { name: shelf.book, data: entry });
                lines.push('服务器无已购条目 → create: HTTP ' + r.status);
                if (r.ok) {
                    const j = await r.json().catch(() => null);
                    lines.push('create 返回: ' + JSON.stringify(j).slice(0, 120));
                }
            } else {
                const r = await serverApi('POST', 'edit', { name: shelf.book, data: entry });
                lines.push('服务器已有已购条目(uid=' + existing.uid + ') → edit: HTTP ' + r.status);
            }
            // 回读验证
            const v = await serverReadBook(shelf.book);
            if (v.ok) {
                const vp = v.entries.find((e) => e && String((e.comment || '') + (e.name || '')).includes('已购衣物库'));
                if (vp) {
                    const vn = ((vp.content || '').match(/[泳睡日内礼]【[泳睡日内礼]\d{2}】/g) || []).length;
                    lines.push('回读验证: 服务器「已购衣物库」存在，' + vn + ' 款' + (vp.content && /泳【泳03】/.test(vp.content) ? '，含泳03 ✓' : '，不含泳03 ✗'));
                } else {
                    lines.push('回读验证: 服务器上没有「已购衣物库」 ✗');
                }
            } else {
                lines.push('回读验证失败: ' + v.err);
            }
        } catch (e) {
            lines.push('异常: ' + String((e && e.message) || e));
        }
        writeServerResult(lines);
    }

    function writeServerResult(lines) {
        diag.serverWriteResult = lines.join('\n');
        log(lines.join('\n'));
        showToast('info', '服务器世界书写入完成，结果已显示');
        try {
            const panel = getSettingsPanel();
            if (panel) {
                const pre = panel.querySelector('#sihs-diag-pre');
                if (pre) { pre.textContent = lines.join('\n'); pre.style.display = 'block'; }
            }
        } catch (e) { /* ignore */ }
    }

    // 导出角色卡（含最新已购衣物库）：平台保存不落盘，唯一可靠的"同步到服务器/编辑器"路径
    // 就是"重新导入卡"。买完衣服点这个 → 下载一张完整 v3 卡 → 导入覆盖原角色 → 服务器就有最新已购库。
    function exportCardNow() {
        try {
            const c = getContext();
            if (!c) { showToast('warning', 'getContext 不可用'); return; }
            const t = getTargetCharacter(c);
            if (!t) { showToast('warning', '未找到目标角色'); return; }
            const { cb } = resolveCharBook(t.char);
            if (!cb) { showToast('error', '目标角色无世界书 data.character_book'); return; }
            // 先把最近的聊天扫一遍（有购买则追加 + 写备份），保证导出的已购库是最新
            try {
                const chat = Array.isArray(c.chat) ? c.chat.slice(-8) : [];
                handleMessages(chat);
            } catch (e) { /* ignore */ }
            // 从备份刷新已购库 content（备份总是最新落点）
            const b = backupFor(charNameKey(t.char));
            if (b && b.content) {
                const pur = cb.entries.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
                if (pur) {
                    pur.content = b.content;
                } else {
                    const built = buildNewPurchasedEntry(t.char, b.content);
                    if (built) cb.entries.push(built);
                }
            }
            // 拼 v3 卡壳
            const data = (t.char.data && typeof t.char.data === 'object') ? t.char.data : t.char;
            data.character_book = cb;
            const card = { spec: 'chara_card_v3', spec_version: '2.0', data };
            const json = JSON.stringify(card, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            let ts = '';
            try { ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); } catch (e) { ts = 'card'; }
            a.href = url;
            a.download = '代替蜜月_已购库' + ts + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 3000);
            const n = (b && Array.isArray(b.purchasedIds)) ? b.purchasedIds.length : 0;
            showToast('info', '已导出角色卡（含已购衣物库 ' + n + ' 款）→ 去"导入角色"覆盖原角色');
            log('导出角色卡：' + a.download + '（已购库 ' + n + ' 款）');
        } catch (e) {
            showToast('error', '导出异常：' + (e && e.message));
        }
    }

    // --- 自检诊断（设置面板按钮，不需要 F12 控制台） ---

    // localStorage 全键盘点：看平台把角色/世界书/设置存在哪些键里（含 st- 前缀）
    function dumpLocalStorageKeys() {
        const out = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                let v = '';
                try { v = localStorage.getItem(k) || ''; } catch (e) { /* ignore */ }
                let flag = '';
                if (/st-|character|world|settings|avatar/i.test(k)) flag += ' ★';
                if (v.length > 0 && (v.includes('代替蜜月') || v.includes('可购买衣物库'))) flag += ' [含代替蜜月/可购买库数据]';
                out.push('  ' + k + '(' + v.length + ')' + flag);
            }
        } catch (e) { out.push('  (遍历异常: ' + (e && e.message) + ')'); }
        return out;
    }

    // context 完整字段盘点：看平台 getContext 到底挂了多少字段
    function dumpContextKeys(c) {
        const out = [];
        if (!c) return out;
        let keys = [];
        try { keys = Object.keys(c); } catch (e) { /* ignore */ }
        for (const k of keys) {
            let t = typeof c[k];
            let extra = '';
            try {
                if (t === 'object' && c[k]) {
                    if (Array.isArray(c[k])) extra = '[' + c[k].length + ']';
                    else extra = '{}';
                }
            } catch (e) { /* ignore */ }
            out.push('  ' + k + ':' + t + extra);
        }
        return out;
    }

    // 全局探测：window / SillyTavern 上关键的角色/世界书/保存符号，并对比 window.characters 与 context.characters 引用
    function dumpGlobals() {
        const out = [];
        const names = ['characters', 'characterBook', 'character_book', 'world_info', 'worldInfo', 'characterId', 'chat_metadata', 'saveCharacter', 'saveCharacterDebounced', 'saveMetadata', 'saveWorldInfo', 'getContext', 'SillyTavern'];
        for (const n of names) {
            let val = null;
            let where = '';
            try { if (window[n] !== undefined) { val = window[n]; where = 'window'; } } catch (e) { /* ignore */ }
            if (val === null && window.SillyTavern) {
                try { if (window.SillyTavern[n] !== undefined) { val = window.SillyTavern[n]; where = 'SillyTavern'; } } catch (e) { /* ignore */ }
            }
            if (val === null) { out.push('  ' + n + ': 不存在'); continue; }
            let desc = '';
            try {
                if (typeof val === 'function') desc = 'function';
                else if (Array.isArray(val)) desc = 'array[' + val.length + ']';
                else if (val && typeof val === 'object') desc = 'object';
                else desc = String(val).slice(0, 60);
            } catch (e) { desc = '?'; }
            out.push('  ' + n + '(' + where + '): ' + desc);
        }
        // 引用对比
        try {
            const c = getContext();
            if (c && c.characters) {
                if (window.characters) {
                    out.push('  window.characters === context.characters: ' + (window.characters === c.characters ? '同一引用' : '不同引用'));
                    if (window.characters !== c.characters && Array.isArray(window.characters)) {
                        out.push('  window.characters 数量: ' + window.characters.length);
                        const idx = (typeof c.characterId === 'number' || typeof c.characterId === 'string') ? Number(c.characterId) : 1;
                        const wc = window.characters[idx];
                        if (wc) {
                            const wcb = (wc.data && wc.data.character_book) || wc.character_book;
                            out.push('  window.characters[' + idx + '] 名: ' + (wc.name || (wc.data && wc.data.name) || '?'));
                            out.push('  window 那份 data.character_book entries: ' + (wcb ? wcb.entries.length : '无'));
                            if (wcb && wcb.entries) {
                                out.push('    含可购买库: ' + (wcb.entries.some((e) => e && String(e.comment || '').includes('可购买衣物库')) ? '是' : '否'));
                                out.push('    含已购库: ' + (wcb.entries.some((e) => e && String(e.comment || '').includes('已购衣物库')) ? '是' : '否'));
                            }
                        }
                    }
                } else {
                    out.push('  window.characters: 不存在（context.characters 无全局对应）');
                }
            }
        } catch (e) { out.push('  (引用对比异常: ' + (e && e.message) + ')'); }
        return out;
    }

    async function runSelfCheck() {
        const lines = [];
        try {
            const context = getContext();
            const c = context ? context : null;
            lines.push('=== 暮蝶做的蜜月换衣间 自检 ===');
            lines.push('[环境]');
            lines.push('getContext: ' + (c ? '可用' : '缺失'));
            if (c) {
                const chars = c.characters || [];
                lines.push('characters 数量: ' + chars.length);
                lines.push('characterId: ' + c.characterId);
                const cur = (typeof c.characterId === 'number' || typeof c.characterId === 'string') ? chars[Number(c.characterId)] : null;
                const curName = cur ? (cur.name || (cur.data && cur.data.name) || '(null)') : '(null)';
                lines.push('当前角色: ' + curName);
            }

            lines.push('[事件]');
            lines.push('onMessage 被调次数: ' + diag.eventCalls);
            lines.push('最近事件类型: ' + (diag.lastEventType || '(无)'));
            lines.push('最近事件携带消息数: ' + diag.lastEventHadMsg);

            lines.push('[轮询]');
            lines.push('轮询运行: ' + (pollTimer ? '是' : '否'));
            lines.push('检查次数: ' + diag.pollChecks);
            lines.push('发现新增批次: ' + diag.pollHits);
            lines.push('轮询追加款式: ' + (diag.pollAdded || '(尚无)'));

            lines.push('[活跃世界书 worldInfo]');
            lines.push('worldInfo 类型: ' + (c && c.worldInfo ? (Array.isArray(c.worldInfo) ? '数组' : typeof c.worldInfo) : 'undefined'));
            if (c && Array.isArray(c.worldInfo)) {
                lines.push('worldInfo 长度: ' + c.worldInfo.length);
                lines.push('worldInfo 含可购买库: ' + (c.worldInfo.some((e) => e && String(e.comment || '').includes('可购买衣物库')) ? '是' : '否'));
                lines.push('worldInfo 含已购库: ' + (c.worldInfo.some((e) => e && String(e.comment || '').includes('已购衣物库')) ? '是' : '否'));
            }
            lines.push('扩展已写入 worldInfo: ' + (diag.wiSynced ? '是' : '否'));
            lines.push('扩展已写入编辑器活动书: ' + (diag.editorSynced ? '是' : '否'));

            lines.push('[平台存储探测]');
            const charBook = c && c.characterBook;
            lines.push('context.characterBook: ' + (charBook ? ((charBook.comment || charBook.name) || '(无名)') + '，entries ' + (Array.isArray(charBook.entries) ? charBook.entries.length : '非数组') : '不存在'));
            if (charBook && Array.isArray(charBook.entries)) {
                lines.push('  characterBook 含已购库: ' + (charBook.entries.some((e) => e && String(e.comment || '').includes('已购衣物库')) ? '是' : '否'));
                lines.push('  characterBook 含可购买库: ' + (charBook.entries.some((e) => e && String(e.comment || '').includes('可购买衣物库')) ? '是' : '否'));
            }
            let wiList = (c && c.settings && Array.isArray(c.settings.world_info)) ? c.settings.world_info : null;
            let wiSrc = 'context.settings.world_info';
            if (!wiList) {
                try { if (Array.isArray(window.world_info)) { wiList = window.world_info; wiSrc = 'window.world_info'; } } catch (e) { /* ignore */ }
            }
            lines.push('世界书列表(' + wiSrc + '): ' + (Array.isArray(wiList) ? wiList.length + ' 本' : '不存在'));
            if (Array.isArray(wiList)) {
                for (const book of wiList.slice(0, 12)) {
                    const hasShelf = Array.isArray(book.entries) && book.entries.some((e) => e && String(e.comment || '').includes('可购买衣物库'));
                    const hasPur = Array.isArray(book.entries) && book.entries.some((e) => e && String(e.comment || '').includes('已购衣物库'));
                    lines.push('  - ' + (book.name || '(无名)') + '：' + (Array.isArray(book.entries) ? book.entries.length : '?') + ' 条' + (hasShelf ? ' [含可购买库]' : '') + (hasPur ? ' [含已购库]' : ''));
                }
            }
            try {
                if (c && typeof c.getWorldInfo === 'function') {
                    const wl = c.getWorldInfo();
                    lines.push('getWorldInfo(): ' + (Array.isArray(wl) ? wl.length + ' 本' : '不可用'));
                }
            } catch (e) { lines.push('getWorldInfo(): 调用异常'); }
            const localHits = [];
            try {
                for (let li = 0; li < localStorage.length; li++) {
                    const lk = localStorage.key(li);
                    try {
                        const lv = localStorage.getItem(lk) || '';
                        if (lv.length > 50 && lv.includes('已购衣物库')) localHits.push(lk + '(' + lv.length + ')');
                    } catch (e) { /* ignore */ }
                }
            } catch (e) { /* ignore */ }
            lines.push('localStorage 含已购衣物库的键: ' + (localHits.length ? localHits.join(', ') : '(无)'));

            lines.push('[角色世界书]');
            const target = c ? getTargetCharacter(c) : null;
            if (!target) {
                lines.push('目标角色: 未找到带「可购买衣物库」的角色');
            } else {
                const { cb, path } = resolveCharBook(target.char);
                diag.charPath = path;
                const entries = (cb && cb.entries) || [];
                lines.push('目标角色: ' + (target.char.name || (target.char.data && target.char.data.name) || '?'));
                lines.push('目标角色下标: ' + target.index + '（characterId=' + c.characterId + '，' + (String(target.index) === String(c.characterId) ? '一致' : '不一致 ← 关注') + '）');
                const idChar = ((typeof c.characterId === 'number' || typeof c.characterId === 'string') && Array.isArray(c.characters) && c.characters[Number(c.characterId)]) ? c.characters[Number(c.characterId)] : null;
                lines.push('characterId 指向: ' + (idChar ? (idChar.name || (idChar.data && idChar.data.name) || '(无名)') : '(无)'));
                if (idChar) {
                    const idcb = resolveCharBook(idChar).cb;
                    lines.push('characterId 角色含可购买库: ' + ((idcb && idcb.entries && idcb.entries.some((e) => e && String(e.comment || '').includes('可购买衣物库'))) ? '是' : '否'));
                }
                lines.push('来源路径: ' + (path || '未找到'));
                lines.push('entries 总数: ' + entries.length);
                const shelf = entries.find((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
                lines.push('可购买库: ' + (shelf ? '有（' + (shelf.content ? shelf.content.length : 0) + ' 字）' : '无'));
                const pur = entries.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
                lines.push('已购衣物库(内存): ' + (pur ? '已创建（' + (pur.content ? pur.content.length : 0) + ' 字）' : '无'));
                // 已购编号记账集合（来自本地备份，模型读不到）
                const curBackup = backupFor(charNameKey(target.char));
                const curIds = (curBackup && Array.isArray(curBackup.purchasedIds)) ? curBackup.purchasedIds : [];
                lines.push('已购编号记账: ' + (curIds.length ? curIds.join('、') : '(空，从空开始)'));
                if (pur && pur.content) {
                    lines.push('内存已购库含泳03(记账): ' + (curIds.includes('泳03') ? '是' : '否'));
                    lines.push('内存已购库款式数: ' + curIds.length);
                    // 内容是否残留编号（v1.6.0 后应为否）
                    const leftover = (pur.content.match(/[泳睡日内礼]【[泳睡日内礼]\d{2}】/g) || []).length;
                    lines.push('已购库内容含编号标记: ' + (leftover ? leftover + ' 处 ⚠ 旧格式' : '否 ✓'));
                }

                // 购买链路测试：对当前可购买库跑一条标准购买消息
                if (shelf && shelf.content) {
                    lines.push('[购买链路测试]');
                    const titles = parseShelfTitles(shelf.content);
                    lines.push('可购买库款式总数: ' + titles.length);
                    const sample = '我要买泳03';
                    const hits = analyzeMessage(sample, titles);
                    if (hits.length) {
                        const b = extractItemBlock(shelf.content, hits[0].cat, hits[0].num);
                        lines.push('发 "' + sample + '" → 命中 ' + hits[0].id + '，切块长度 ' + (b ? b.length : 0) + ' 字 → 会追加 ✓');
                    } else {
                        lines.push('发 "' + sample + '" → 未命中（可购买库或消息格式有变）✗');
                    }
                    // 最近消息审计
                    if (diag.recentMessages.length) {
                        lines.push('[最近消息审计]');
                        for (const m of diag.recentMessages) {
                            const h = analyzeMessage(m.text || '', titles);
                            lines.push((m.role || '?') + ': ' + JSON.stringify((m.text || '').slice(0, 40)) + ' → ' + (h.length ? ('命中 ' + h.map(x => x.id).join(',')) : '未命中'));
                        }
                    }
                }
            }

            lines.push('[保存]');
            lines.push('上次同步: ' + (diag.lastAdded || '(尚无)') + (diag.lastSyncAt ? ' @ ' + fmtTime(diag.lastSyncAt) : ''));
            lines.push('探测到的保存接口: ' + (diag.lastSaveFound.length ? diag.lastSaveFound.join(', ') : '(无)'));
            lines.push('上次调用路径: ' + (diag.lastSaveMethod || '(无)') + (diag.lastSaveAt ? ' @ ' + fmtTime(diag.lastSaveAt) : ''));
            lines.push('上次保存错误: ' + (diag.lastSaveError || '(无)'));
            // 环境里所有带 save 的可调用函数（看云平台到底挂了哪些）
            const envSave = [];
            try {
                if (c) { for (const k of Object.keys(c)) { if (/save/i.test(k) && typeof c[k] === 'function') envSave.push('ctx.' + k); } }
                if (window.SillyTavern) { for (const k of Object.keys(window.SillyTavern)) { if (/save/i.test(k) && typeof window.SillyTavern[k] === 'function') envSave.push('ST.' + k); } }
                for (const k of Object.keys(window)) { if (/save/i.test(k) && typeof window[k] === 'function') envSave.push('win.' + k); }
            } catch (e) { /* ignore */ }
            lines.push('环境含save的函数: ' + (envSave.length ? Array.from(new Set(envSave)).join(', ') : '(无)'));

            lines.push('[保存请求拦截]');
            if (diag.saveRequests.length) {
                for (const r of diag.saveRequests.slice(-15)) {
                    lines.push('  ' + fmtTime(r.t) + ' ' + r.method + ' ' + r.url + ' (status=' + (r.status !== undefined ? r.status : '?') + ', body ' + (r.len || 0) + 'B)');
                }
            } else {
                lines.push('  (暂无抓到的写请求——还没触发过保存)');
            }
            lines.push('[localStorage 全键]');
            const lsKeys = dumpLocalStorageKeys();
            if (lsKeys.length) { lsKeys.forEach((l) => lines.push(l)); }
            else { lines.push('  (空)'); }
            lines.push('[context 完整字段]');
            const ckKeys = dumpContextKeys(c);
            if (ckKeys.length) { ckKeys.forEach((l) => lines.push(l)); }
            else { lines.push('  (无)'); }
            lines.push('[全局探测]');
            const glKeys = dumpGlobals();
            if (glKeys.length) { glKeys.forEach((l) => lines.push(l)); }
            else { lines.push('  (无)'); }

            lines.push('[本地备份]');
            const charName = target && target.char ? (target.char.name || (target.char.data && target.char.data.name)) : '';
            const b = charName ? backupFor(charName) : null;
            if (b) {
                lines.push('备份含当前角色: 是');
                lines.push('备份内容长度: ' + (b.content ? b.content.length : 0));
                lines.push('备份编号记账: ' + (Array.isArray(b.purchasedIds) ? b.purchasedIds.join('、') : '(无)'));
                lines.push('备份款式数: ' + (Array.isArray(b.purchasedIds) ? b.purchasedIds.length : 0));
                lines.push('备份时间: ' + fmtTime(b.updatedAt));
            } else {
                lines.push('备份含当前角色: 否');
            }

            // 服务器世界书扫描（异步，放最后，不阻塞前面）
            try {
                lines.push('[服务器世界书]');
                const all = await serverBookNames();
                if (!all.ok) {
                    lines.push('  all 失败: ' + all.err + '（此平台可能没开 /api/worldinfo 路由）');
                } else if (!all.names.length) {
                    lines.push('  （服务器返回空列表）');
                } else {
                    for (const name of all.names) {
                        try {
                            const r = await serverReadBook(name);
                            if (!r.ok) { lines.push('  - ' + name + '：读取失败 ' + r.err); continue; }
                            const hasShelf = r.entries.some((e) => e && String((e.comment || '') + (e.name || '')).includes('可购买衣物库'));
                            const hasPur = r.entries.some((e) => e && String((e.comment || '') + (e.name || '')).includes('已购衣物库'));
                            lines.push('  - ' + name + '：' + r.entries.length + ' 条' + (hasShelf ? ' [含可购买库]' : '') + (hasPur ? ' [含已购库]' : ''));
                            if (hasShelf) {
                                const shelfE = r.entries.find((e) => e && String((e.comment || '') + (e.name || '')).includes('可购买衣物库'));
                                if (shelfE && shelfE.content) lines.push('    可购买库内容长度: ' + shelfE.content.length + ' 字');
                                if (shelfE && shelfE.uid !== undefined) lines.push('    可购买库 uid: ' + shelfE.uid);
                            }
                        } catch (e) { lines.push('  - ' + name + '：扫描异常'); }
                    }
                }
                diag.serverScan = lines[lines.length - 1] || '';
                diag.serverScanAt = Date.now();
            } catch (e) {
                lines.push('[服务器世界书] 扫描异常: ' + String((e && e.message) || e));
            }

            lines.push('[加载恢复]');
            lines.push('最近一次: ' + (diag.loadReapply || '(尚未执行)'));

            lines.push('[面板状态]');
            lines.push('启用开关: ' + (extensionEnabled ? '开' : '关'));
            if (diag.wiTestResult) {
                lines.push('');
                lines.push(diag.wiTestResult);
            }
            if (diag.serverWriteResult) {
                lines.push('');
                lines.push(diag.serverWriteResult);
            }
        } catch (e) {
            lines.push('自检异常: ' + (e && e.message));
        }
        return lines.join('\n');
    }

    // 调试钩子：F12 可跑 window.__sihsDebug.reapplyOnLoad() / getDiag() / getBackup() / testPurchase(text)
    function exposeDebug() {
        try {
            window.__sihsDebug = {
                reapplyOnLoad: () => { reapplyOnLoad(); return runSelfCheck(); },
                getDiag: async () => ({ diag, selfCheck: await runSelfCheck() }),
                getBackup: () => loadBackup(),
                forceSync: forceSyncNow,
                testSave: testSaveNow,
                // 测试任意购买消息：返回命中+切块结果（不改任何数据）
                testPurchase: (text) => {
                    const c = getContext();
                    const t = c ? getTargetCharacter(c) : null;
                    if (!t) return '未找到目标角色';
                    const { cb } = resolveCharBook(t.char);
                    const shelf = cb && cb.entries.find((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
                    if (!shelf) return '未找到可购买库';
                    const titles = parseShelfTitles(shelf.content);
                    const hits = analyzeMessage(text || '', titles);
                    if (!hits.length) return '未命中（text=' + JSON.stringify(text) + '）';
                    return hits.map((h) => {
                        const b = extractItemBlock(shelf.content, h.cat, h.num);
                        return h.id + '(' + h.by + ') 切块' + (b ? b.length : 0) + '字';
                    }).join('; ');
                },
            };
        } catch (e) { /* ignore */ }
    }

    function init() {
        migrateBackupV2(); // 清旧 v1 备份（含编号+预置款式），从空开始
        installRequestHook(); // 先装保存请求拦截，越早越好
        loadExtensionEnabled();
        if (eventSource && event_types) {
            eventSource.on(event_types.MESSAGE_RECEIVED, function () {
                diag.lastEventType = 'MESSAGE_RECEIVED';
                onMessage.apply(null, arguments);
            });
            eventSource.on(event_types.MESSAGE_SENT, function () {
                diag.lastEventType = 'MESSAGE_SENT';
                onMessage.apply(null, arguments);
            });
            if (event_types.CHARACTER_LOADED) {
                // 切角色后重新恢复（防平台保存不落盘）
                eventSource.on(event_types.CHARACTER_LOADED, () => scheduleReapply());
            }
            if (event_types.APP_READY) {
                eventSource.on(event_types.APP_READY, () => scheduleReapply());
            }
        }
        log('扩展已加载，监听购买场景。');
        exposeDebug();
        startPolling(); // 轮询兜底：不依赖平台事件系统
        scheduleReapply(); // 页面加载后按重试节奏尝试恢复本地备份
        initSettingsPanel();
    }

    // 重试恢复：characters 可能还没加载完，最多试 20 次（每次 1.2s）。
    function scheduleReapply() {
        let tries = 0;
        const tryApply = () => {
            const ok = reapplyOnLoad();
            if (ok || tries++ >= 20) return;
            setTimeout(tryApply, 1200);
        };
        setTimeout(tryApply, 400);
    }

    init();
})();
