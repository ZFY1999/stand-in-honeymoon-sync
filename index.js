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
    // 货架读取源：auto（默认）/ replace-honeymoon / global
    const STORAGE_KEY_SHELF_SOURCE = 'standInHoneyMoonSync_shelfSource_v1';
    // 已购库本地备份：v2 起含 content（无编号，模型可读）+ purchasedIds（编号记账集合，模型读不到）。
    // 云平台若保存不落盘，扩展每次加载从这恢复，保证模型能读到已购库、防重复对账有据。
    // v1.7.0：备份键升级为「角色名::指纹」（防同名角色串写），兼容旧「角色名」键自动迁移。
    const STORAGE_KEY_BACKUP = 'standInHoneyMoonSync_backup_v2';
    // v1 备份（含编号的旧 content + 预置款式）一次性清除，避免 9 款默认衣服回灌。
    const STORAGE_KEY_BACKUP_V1 = 'standInHoneyMoonSync_backup_v1';
    const SETTINGS_EXTENSION_NAME = 'stand-in-honeymoon-sync';
    const SETTINGS_VERSION = '1.7.0';

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

    // 角色稳定指纹：avatar 路径 > data.id（防同名角色串写；无稳定 id 时退化为纯名字键，兼容旧数据）
    function roleFingerprint(char) {
        if (!char) return '';
        const d = (char && char.data) || {};
        const raw = String(d.avatar || d.id || char.avatar || '');
        return raw.replace(/[\/\\\s]/g, '_') || '';
    }
    // 备份键：角色名::指纹（闸3）；无指纹时退化为纯角色名（兼容旧格式键）
    function roleBackupKey(char, name) {
        const n = name || charNameKey(char);
        const fp = roleFingerprint(char);
        return fp ? (n + '::' + fp) : n;
    }

    // 备份按「当前聊天角色」读写：键=角色名::指纹；旧「纯角色名」键命中时自动迁移（防同名串写 + 兼容老数据）
    function backupFor(role) {
        if (!role || !role.char) return null;
        const map = loadBackup();
        const name = role.name || charNameKey(role.char);
        const key = roleBackupKey(role.char, name);
        if (map[key]) return map[key];
        const legacy = map[name];
        if (legacy) { map[key] = legacy; saveBackup(map); return legacy; }
        return null;
    }
    function writeBackup(role, content, purchasedIds) {
        if (!role || !role.char) return;
        const map = loadBackup();
        const name = role.name || charNameKey(role.char);
        map[roleBackupKey(role.char, name)] = {
            content,
            purchasedIds: Array.isArray(purchasedIds) ? purchasedIds : [],
            updatedAt: Date.now(),
        };
        saveBackup(map);
    }
    function refreshBackup(role, content, purchasedIds) {
        if (!role || !role.char) return;
        const map = loadBackup();
        const name = role.name || charNameKey(role.char);
        const key = roleBackupKey(role.char, name);
        const b = map[key];
        const ids = Array.isArray(purchasedIds)
            ? purchasedIds
            : (b && Array.isArray(b.purchasedIds) ? b.purchasedIds : []);
        if (!b || b.content !== content) {
            map[key] = { content, purchasedIds: ids, updatedAt: Date.now() };
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

    // 已购衣物库初始模板（分区 + 头部声明 + 编号认知）——v1.7.0 索引式：只登记编号+款式名一行索引，全文权威在可购买库。
    const PURCHASED_TEMPLATE = [
        '# 已购衣物库（剧情中购买获得的衣物清单）',
        '【定位】本条目记录角色在剧情中通过购物/购买流程获得的衣物，均来自「可购买衣物库」的已购款式。本条目衣物已在剧情中购买获得，可直接取用穿着，无需再走购买流程，与「已有衣物库」（出发时随行的既有衣物）相对。',
        '【已购转移豁免】本条目为已购衣物的【权威索引】：其中衣物已经明确购买并确认获得，不受「可购买衣物库」"未购买视为不存在""绝不允许直接穿着"等防误用约束的限制。',
        '【索引式登记】本条目【只登记编号与款式名索引，不复制完整设定】——每个已购款式的完整设定（含【款式外观】【实际结构】【动态反应】【隐藏标记】等）一律以「可购买衣物库」为唯一权威。角色穿着本条目衣物时，按编号返回「可购买衣物库」查询对应设定并持续调用。',
        '【性质声明】本条目衣物来自「可购买衣物库」，保留其完整设定，包括色情款的【隐藏标记】【实际结构】等隐藏特性。本条目【不适用】「已有衣物库」头部"无色情特性"的约定。',
        '【色情设定隐藏规则延续】角色购买、入手本条目衣物时，仍不知晓其隐藏特性（走光、透明、滑落等）；此类特性只在实际穿着后，经动作或环境（风、水、卧姿、活动）作用时才逐步显现，角色此时略感意外，不会早有预料。规则与「可购买衣物库」完全一致。',
        '【编号认知】本条目编号（泳/睡/日/内/礼 01-20）为系统记账标记，仅供扩展与设定追踪使用。当前角色及剧情中产生的NPC均【不知晓】编号，剧情中不得以编号称呼衣物，任何角色台词、旁白、心理描写一律只以款式名称呼；文本中出现的编号仅视为扩展记账痕迹，不代表角色认知编号。',
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
        '- 本条目由扩展自动维护：购买一件登记一行索引（款式名+编号），按编号防重复，只增不改不删。',
        '- 完整设定以「可购买衣物库」为唯一权威，穿着时按编号返回可购买库查询。',
        '- 编号仅存于扩展记账层与索引行，角色与剧情不知晓编号，剧情中只以款式名指代衣物。',
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

    // 货架读取源：auto（默认，推荐）/ replace-honeymoon（代替蜜月专属书）/ global（全局《暮蝶衣物库》）
    let shelfSourceMode = 'auto';
    function loadShelfSource() {
        try {
            const v = localStorage.getItem(STORAGE_KEY_SHELF_SOURCE);
            shelfSourceMode = (v === 'replace-honeymoon' || v === 'global') ? v : 'auto';
        } catch (e) {
            shelfSourceMode = 'auto';
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

    // 把索引行（款式名+编号）追加进已购衣物库 content 对应分类小节（在「## 分类名」之后、下一分区之前）。
    // v1.7.0 索引式：只登记一行索引（款式名+编号），全文权威在可购买库，绝不复制完整设定。
    function appendItem(purchasedContent, cat, block) {
        const sectionTitle = `## ${CATEGORY_NAMES[cat]}`;
        const si = purchasedContent.indexOf(sectionTitle);
        if (si === -1) return purchasedContent; // 找不到分区则不动，安全
        const after = purchasedContent.slice(si + sectionTitle.length);
        const nextSectionRe = /^##\s/m;
        const ns = nextSectionRe.exec(after);
        const insertAt = ns ? si + sectionTitle.length + ns.index : purchasedContent.length;
        const insertion = `${block}\n`;
        return purchasedContent.slice(0, insertAt) + insertion + purchasedContent.slice(insertAt);
    }

    // ---- v1.7.0：当前聊天角色识别 + 货架读取源 + 已购库写入目标 ----

    // 识别当前聊天角色：characterId 四层兼容（数字/字符串数字/UUID/chat 首条 character_id）+ 单角色兜底。
    // 返回 { char, index, name, fingerprint, reason }；识别失败 char=null（宁可空转不猜着写）。
    function resolveCurrentChatRole(context) {
        if (!context) return { char: null, reason: 'getContext 不可用' };
        const chars = Array.isArray(context.characters) ? context.characters : [];
        const pick = (i) => {
            const n = Number(i);
            if (!Number.isInteger(n) || n < 0 || n >= chars.length) return null;
            return chars[n];
        };
        const id = context.characterId;
        let char = null;
        // 1) 数字 / 字符串数字
        if (typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))) {
            char = pick(id);
        }
        // 2) UUID：按 data.id / data.avatar 包含匹配
        if (!char && typeof id === 'string' && /^[0-9a-fA-F-]{8,}$/.test(id)) {
            char = chars.find((c) => c && c.data && String(c.data.id || c.data.avatar || '').includes(id)) || null;
        }
        // 3) chat 首条 character_id
        if (!char && Array.isArray(context.chat)) {
            for (const m of context.chat) {
                const cid = (m && m.character_id !== undefined) ? m.character_id : (m && m.characterId);
                if (cid !== undefined && cid !== null) { char = pick(cid); if (char) break; }
            }
        }
        // 4) 单角色兜底
        if (!char && chars.length === 1) char = chars[0];
        if (!char) {
            return { char: null, reason: (chars.length ? ('characterId 无法定位（id=' + id + '）') : 'characters 为空') };
        }
        const index = chars.indexOf(char);
        const name = charNameKey(char);
        return { char, index, name, fingerprint: roleFingerprint(char), reason: 'ok' };
    }

    // 克隆源触发词字段适配：全局书用 key，代替蜜月用 keys，都没有 → 兜底。已购库条目按克隆源取同款字段。
    function cloneKeyField(model) {
        const pick = (k) => (model && Array.isArray(model[k]) && model[k].length)
            ? JSON.parse(JSON.stringify(model[k])) : null;
        return pick('key') || pick('keys') || ['已购', '衣物', '购买', '购入'];
    }

    // 确保当前角色有世界书结构（角色卡没带 character_book 时建一个空壳，供已购库落位）。返回 { cb, path }。
    function ensureCharBook(char) {
        const found = resolveCharBook(char);
        if (found && found.cb) return found;
        if (!char) return { cb: null, path: '' };
        try {
            // 标准酒馆卡：character_book 在顶层或 data 里
            if (char.data && typeof char.data === 'object') {
                if (!char.data.character_book) char.data.character_book = { entries: [] };
                else if (!Array.isArray(char.data.character_book.entries)) char.data.character_book.entries = [];
                return { cb: char.data.character_book, path: 'data.character_book(新建)' };
            }
            if (!char.character_book) char.character_book = { entries: [] };
            else if (!Array.isArray(char.character_book.entries)) char.character_book.entries = [];
            return { cb: char.character_book, path: 'character_book(新建)' };
        } catch (e) {
            return { cb: null, path: '' };
        }
    }

    // 当前角色卡本地世界书是否自带「可购买衣物库」货架（auto 识别依据：卡里有货架 → 读专属书，否则 → 全局书）
    function charHasShelfLocally(char) {
        if (!char) return false;
        const { cb } = resolveCharBook(char);
        return !!(cb && Array.isArray(cb.entries) && cb.entries.some((e) => e && e.comment && String(e.comment).includes('可购买衣物库')));
    }

    // 林婉清模式是否激活：auto 卡内带货架 → 激活；强制 replace-honeymoon → 激活；global → 不激活。
    // 返回 { active, reason }。状态栏/诊断反馈用（「林婉清模式已对齐世界书」的判断依据）。
    function linWanqingModeActive(role) {
        if (shelfSourceMode === 'replace-honeymoon') return { active: true, reason: '强制专属书' };
        if (shelfSourceMode === 'global') return { active: false, reason: '强制全局书' };
        const hasShelf = charHasShelfLocally(role && role.char);
        return { active: hasShelf, reason: hasShelf ? '卡内自带可购买衣物库' : '卡内无货架（读全局书）' };
    }

    // 货架（可购买衣物库 content）从哪读。
    // auto：当前角色卡内包含「可购买衣物库」条目 → 读该角色的专属书；否则 → 全局书《暮蝶衣物库》。
    //       （不再按角色名猜：卡自带货架就以卡为准，其他卡统一读全局书。）
    // replace-honeymoon=强制专属书；global=强制全局书。
    // 全局书只读不建：检测不到返回 found:false，绝不自动创建。
    // 返回 { content, name, mode, found, err }
    async function getShelfSource(context, role) {
        let effective = shelfSourceMode;
        if (effective === 'auto') {
            effective = charHasShelfLocally(role && role.char) ? 'replace-honeymoon' : 'global';
        }
        const inCharBook = (char) => {
            const { cb } = resolveCharBook(char);
            if (!cb || !Array.isArray(cb.entries)) return null;
            const s = cb.entries.find((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
            return s ? { content: s.content || '', name: '角色世界书' } : null;
        };
        const inServerBook = async (bookName) => {
            if (!bookName) return null;
            const r = await serverGetBook(bookName);
            if (!r.ok) return null;
            const s = findEntryByComment(r.book, '可购买衣物库');
            return s ? { content: s.content || '', name: bookName } : null;
        };
        const inMemoryWorldLists = () => {
            let list = null;
            try {
                if (context && context.settings && Array.isArray(context.settings.world_info)) list = context.settings.world_info;
                else if (Array.isArray(window.world_info)) list = window.world_info;
            } catch (e) { list = null; }
            if (!Array.isArray(list)) return null;
            for (const book of list) {
                if (!book || !Array.isArray(book.entries)) continue;
                const s = book.entries.find((e) => e && e.comment && String(e.comment).includes('可购买衣物库'));
                if (s) return { content: s.content || '', name: book.name || '全局世界书' };
            }
            return null;
        };
        // 服务器上找含「可购买衣物库」的书（全量扫兜底，读全局书用）
        const scanServer = async () => {
            const bn = await resolveServerBookName(role && role.name ? role.name : '');
            if (!bn) return null;
            return await inServerBook(bn);
        };

        if (effective === 'replace-honeymoon') {
            let r = (role && role.char) ? inCharBook(role.char) : null;
            if (!r) r = await scanServer();
            if (r) return { content: r.content, name: r.name, mode: effective, found: true };
            return { content: '', name: '', mode: effective, found: false, err: '角色专属书里没找到「可购买衣物库」条目' };
        }
        // global
        let r = inMemoryWorldLists();
        if (!r) r = await scanServer();
        if (r) return { content: r.content, name: r.name, mode: effective, found: true };
        return { content: '', name: '', mode: effective, found: false, err: '全局书《暮蝶衣物库》未检测到（请在平台上导入，扩展只读不建）' };
    }

    // 已购库写哪：永远写当前角色自己的世界书（闸1：写目标绑定当前聊天角色，换聊天跟着变）。
    // 返回 { entry, cb, path, target }；entry 为本地角色世界书里的「已购衣物库」条目（没有则新建）。
    function getWardrobeBook(role) {
        if (!role || !role.char) return { entry: null, err: '未识别到当前聊天角色' };
        const { cb, path } = ensureCharBook(role.char);
        if (!cb || !Array.isArray(cb.entries)) {
            return { entry: null, err: '当前角色无世界书结构且创建失败', noBook: true };
        }
        let entry = cb.entries.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
        if (!entry) {
            entry = buildNewPurchasedEntry(role.char, PURCHASED_TEMPLATE);
            if (entry) log('创建「已购衣物库」条目（写入当前角色世界书）');
        }
        return { entry, cb, path, target: '当前角色世界书' };
    }

    // 照「已有衣物库/可购买衣物库」条目拷贝字段，新建「已购衣物库」条目。
    // 克隆源字段：全局书用 key、代替蜜月用 keys（cloneKeyField 适配）；model 兜底：已有库 → 可购买库 → 默认字段。
    function buildNewPurchasedEntry(char, template) {
        const { cb } = ensureCharBook(char);
        if (!cb) return null;
        const model = cb.entries.find(
            (e) => e && e.comment && String(e.comment).includes('已有衣物库'),
        ) || cb.entries.find(
            (e) => e && e.comment && String(e.comment).includes('可购买衣物库'),
        ) || null;
        const entry = {
            comment: '已购衣物库',
            content: template,
            constant: true,
            selective: true,
            insertion_order: 89, // 略大于已有衣物库(88)，排在它后面
            enabled: true,
            position: 'after_char',
            use_regex: true,
            // 同等地位：继承克隆源的触发关键词（换衣/穿着/整理行李等场景同样激活）
            keys: cloneKeyField(model),
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
    // v1.7.0 守卫：只在数组【已含「已购衣物库」条目】时更新——已购库的首次创建永远发生在当前角色自己的
    // 世界书（getWardrobeBook / 服务器 角色名_Worldbooks），绝不在此新建，防止把已购库写进全局书《暮蝶衣物库》。
    function syncToActiveWorld(context, content) {
        if (!context || !Array.isArray(context.worldInfo)) return false;
        const entry = context.worldInfo.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
        if (!entry) return false; // 这本书没有已购库条目 → 不是扩展维护过的角色书/是全局书，不动
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
            // v1.7.0 守卫：只更新已含「已购衣物库」的书（首次创建在角色书里做，绝不污染全局书）
            const entry = entriesArr.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
            if (!entry) return false;
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
            handleMessages(newMsgs, true).catch(() => { /* 轮询静默 */ });
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

    // 旧格式迁移：把 v1.6.x 全文式已购库重建为索引式（从货架提取款式名，逐行登记索引）。
    // 货架读不到（全局书未导入等）时返回 null，上层保留旧 content 不清除（宁可保留也不丢数据）。
    async function migrateToIndexFormat(role, ids) {
        try {
            const context = getContext();
            const shelf = await getShelfSource(context, role);
            if (!shelf.found) return null;
            const titles = parseShelfTitles(shelf.content);
            let content = PURCHASED_TEMPLATE;
            for (const id of ids) {
                const t = titles.find((x) => x.id === id);
                if (!t) continue;
                content = appendItem(content, t.cat, `${t.cat}【${t.id}】${t.title}`);
            }
            return content;
        } catch (e) {
            return null;
        }
    }

    // 核心链路（v1.7.0）：
    //   当前聊天角色 → 货架读取源(getShelfSource) → 已购库写入目标(getWardrobeBook，永远当前角色自己的世界书)
    //   解析购买消息 → 登记一行索引（款式名+编号）→ 本地备份 → 同步角色书/服务器角色名_Worldbooks。
    //   全局书只读不建；识别失败宁可空转不猜着写（闸1）。
    async function handleMessages(messages, fromPoll) {
        if (!extensionEnabled) return; // 设置里关了总开关则跳过
        const context = getContext();
        if (!context) return;
        // 1) 当前聊天角色（闸1：写目标绑当前聊天角色，换聊天/切角色写目标跟着变）
        const role = resolveCurrentChatRole(context);
        if (!role || !role.char) {
            if (!fromPoll) log('未识别当前聊天角色（' + (role && role.reason) + '），跳过本次同步');
            return;
        }
        // 2) 货架读取源
        const shelf = await getShelfSource(context, role);
        if (!shelf.found) {
            // 全局书只读不建：检测不到就提示，绝不自动创建
            if (!fromPoll) showToast('warning', '货架读取失败：' + (shelf.err || '未找到可购买衣物库'));
            log('货架读取失败：' + (shelf.err || ''));
            return;
        }
        const shelfTitles = parseShelfTitles(shelf.content);
        // 3) 已购库写当前角色自己的世界书
        const wb = getWardrobeBook(role);
        if (!wb.entry) {
            if (!fromPoll) showToast('warning', '已购库写入目标不可用：' + (wb.err || ''));
            log('已购库写入目标不可用：' + (wb.err || ''));
            return;
        }
        let content = wb.entry.content || '';
        // 已购编号记账集合：来自本地备份（唯一权威），防重复对账用；模型读不到（独立记账层，不进 content 编号以外的部分）
        const b = backupFor(role);
        let purchasedIds = (b && Array.isArray(b.purchasedIds)) ? b.purchasedIds.slice() : [];
        let changed = false;
        const added = [];

        for (const msg of messages) {
            const mtext = msgText(msg);
            if (!mtext) continue;
            const buys = analyzeMessage(mtext, shelfTitles);
            for (const buy of buys) {
                if (isAlreadyPurchased(purchasedIds, buy.id)) {
                    log(`跳过重复：${buy.id}`);
                    continue;
                }
                // v1.7.0：已购库只登记一行索引（款式名+编号），全文权威在可购买库，绝不复制完整设定
                const t = shelfTitles.find((x) => x.id === buy.id);
                const title = t ? t.title : '';
                if (!title) {
                    log(`在可购买库找不到 ${buy.id} 的款式名，跳过`);
                    continue;
                }
                const indexLine = `${buy.cat}【${buy.id}】${title}`;
                content = appendItem(content, buy.cat, indexLine);
                purchasedIds.push(buy.id);
                changed = true;
                added.push(`${buy.id}(${buy.by === 'title' ? '款式名' : '编号'})`);
            }
        }

        if (!changed) {
            // 没新增款式也提示，方便确认"点同步"确实执行过（避免以为按钮没反应）
            if (fromPoll) { /* 轮询静默 */ } else {
                log('同步检查完成：无新增购买');
            }
            return;
        }
        wb.entry.content = content;

        diag.lastAdded = added.join('、');
        diag.lastSyncAt = Date.now();
        diag.charPath = wb.path || '';
        if (fromPoll) diag.pollAdded = added.join('、');
        writeBackup(role, content, purchasedIds); // 无论平台是否落盘，本地备份先存
        // 关键：同步到活跃世界书（守卫：只有已含已购库的书才更新，避免污染全局书）
        diag.wiSynced = syncToActiveWorld(context, content);
        if (diag.wiSynced) log('已同步进活跃世界书（context.worldInfo）');
        diag.editorSynced = syncToEditorState(context, content);
        if (diag.editorSynced) log('已同步进编辑器活动书（characterBook/settings.world_info）');

        // 保存：把所有候选保存接口全开火（谁真正落盘谁负责），不因单个成功短路。
        if (!saveCharacterSafe(context, role.index, role.char)) {
            log('保存角色失败：找不到可用的保存接口（本地备份已存，下次加载自动恢复）');
            showToast('warning', '自动保存失败：已存本地备份，下次打开自动恢复已购库');
        } else {
            log(`已购衣物已同步：${added.join('、')}（已触发保存：${diag.lastSaveMethod}）`);
        }

        // 真落盘：写入服务器世界书（当前角色自己的书：角色名_Worldbooks）。
        // fire-and-forget，不阻塞对话；结果进 diag，失败静默（本地备份兜底）。
        // 全局书只读不建：写目标永远是当前角色自己的书，绝不写全局《暮蝶衣物库》。
        // openEditor=false：自动链路不把编辑台顶出来打断聊天，只刷新缓存/列表；编辑台开着这本书才会即时重绘。
        syncServerPurchased(content, purchasedIds, false, role).then((r) => {
            diag.serverWriteResult = r.lines.join('\n');
            if (r.ok) {
                log('已购库已写入服务器世界书（' + added.join('、') + '）');
            } else {
                log('服务器世界书同步跳过/失败（不影响本地与备份）：' + r.lines.join(' | '));
            }
        }).catch((e) => {
            log('服务器世界书同步异常（已静默）：', e);
        });
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
            const role = resolveCurrentChatRole(context);
            if (!role || !role.char) { diag.loadReapply = '未识别当前聊天角色（' + (role && role.reason) + '）'; return false; }
            const wb = getWardrobeBook(role);
            if (!wb.entry) {
                diag.loadReapply = '当前角色无已购库写入目标（' + (wb.err || '') + '）——正常，尚未购买';
                return true;
            }
            diag.charPath = wb.path || '';
            const existing = wb.entry;
            const b = backupFor(role);
            const backupIds = (b && Array.isArray(b.purchasedIds)) ? b.purchasedIds.slice() : [];
            const restoreContent = (c) => {
                // 恢复动作：写内存 + 同步进活跃世界书/编辑器活动书 + 保存（守卫：只有已含已购库的书才更新）
                if (Array.isArray(context.worldInfo) &&
                    context.worldInfo.some((e) => e && e.comment && String(e.comment).includes('已购衣物库'))) {
                    diag.wiSynced = syncToActiveWorld(context, c) || diag.wiSynced;
                }
                diag.editorSynced = syncToEditorState(context, c) || diag.editorSynced;
                saveCharacterSafe(context, role.index, role.char);
            };
            // 旧格式迁移：全文式已购库（v1.6.x，含以【款式外观】/【实际结构】开头的完整设定段）→ 索引式。
            // 判定用【行首段落】匹配，避免误伤 v1.7.0 索引式模板（模板【性质声明】里也含「实际结构」字样，但不在行首）。
            // 提取编号从货架重建索引；货架读不到（全局书未导入等）则保留旧内容不清除（宁可保留也不丢数据）。
            const isLegacyFull = !!(existing.content && /^【款式外观】|^【实际结构】|^【动态反应】/m.test(existing.content));
            if (isLegacyFull) {
                const legacyIds = [];
                const mre = /【([泳睡日内礼])(\d{2})】/g;
                let mm;
                while ((mm = mre.exec(existing.content || '')) !== null) {
                    legacyIds.push(mm[1] + mm[2]);
                }
                const ids = legacyIds;
                const merged = Array.from(new Set([...backupIds, ...ids]));
                if (merged.length) {
                    diag.loadReapply = `检测到旧格式已购库（${merged.length} 款），异步迁移为索引式…`;
                    migrateToIndexFormat(role, merged).then((newContent) => {
                        if (newContent) {
                            existing.content = newContent;
                            writeBackup(role, newContent, merged);
                            restoreContent(newContent);
                            diag.loadReapply = `旧格式已购库已迁移为索引式（${merged.length} 款）`;
                            log('旧格式已购库已迁移为索引式（' + merged.length + ' 款）');
                        } else {
                            diag.loadReapply = '旧格式已购库保留（货架不可用，未迁移，不丢数据）';
                        }
                    });
                    return true;
                }
            }
            if (backupIds.length) {
                existing.content = b.content;
                diag.loadReapply = `从备份覆盖恢复已购衣物库（${backupIds.length} 款）`;
                restoreContent(existing.content);
                return true;
            }
            // 备份空：条目为空白模板，保持干净，只刷新备份
            refreshBackup(role, existing.content, []);
            diag.loadReapply = '内存已有已购衣物库（空白模板，无已购记录）';
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
            handleMessages(messages).catch((e) => { log('处理消息出错（已静默）：', e); });
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

        // 清空已购（从零开始）：清本地备份键 + 服务器已购库重置空白模板（新卡不继承旧记录）
        const $reset = panel.querySelector('#sihs-reset-purchased');
        if ($reset) {
            $reset.addEventListener('click', async () => {
                if (!confirm('确定清空当前角色的已购衣物记录？本地备份 + 服务器世界书都会重置为空白模板，无法撤销。')) return;
                const r = await resetPurchasedNow();
                const lines = r.lines || ['（无输出）'];
                diag.serverWriteResult = lines.join('\n');
                log(lines.join('\n'));
                const pre = panel.querySelector('#sihs-diag-pre');
                if (pre) { pre.textContent = lines.join('\n'); pre.style.display = 'block'; }
                showToast(r.ok ? 'info' : 'warning', r.ok ? '已清空，从零开始' : '清空完成但结果有异常，见诊断');
                updateSettingsStatus();
            });
        }

        // 可购买库读取源：auto / replace-honeymoon / global（localStorage 持久化）
        const $src = panel.querySelector('#sihs-shelf-source');
        if ($src) {
            $src.value = shelfSourceMode;
            $src.addEventListener('change', () => {
                shelfSourceMode = ($src.value === 'replace-honeymoon' || $src.value === 'global') ? $src.value : 'auto';
                try { localStorage.setItem(STORAGE_KEY_SHELF_SOURCE, shelfSourceMode); } catch (e) { /* ignore */ }
                resolvedBookName = ''; resolvedBookNameAt = 0; // 清缓存，下次重新定位
                try {
                    const label = $src.selectedOptions && $src.selectedOptions[0] ? $src.selectedOptions[0].text : shelfSourceMode;
                    showToast('info', '货架读取源已切换：' + label);
                } catch (e) { /* ignore */ }
                updateSettingsStatus();
            });
        }

        // 服务器世界书名：读/写 localStorage；改了清掉缓存重新定位
        const $wbName = panel.querySelector('#sihs-worldbook-name');
        if ($wbName) {
            try { $wbName.value = localStorage.getItem('standInHoneyMoonSync_worldbookName_v1') || ''; } catch (e) { /* ignore */ }
            $wbName.addEventListener('input', () => {
                try { localStorage.setItem('standInHoneyMoonSync_worldbookName_v1', String($wbName.value || '').trim()); } catch (e) { /* ignore */ }
                resolvedBookName = ''; resolvedBookNameAt = 0; // 清缓存，下次重新定位
                updateSettingsStatus();
            });
        }

        // 复制诊断：把自检/最近结果拷到剪贴板，直接发暮蝶
        const $copyDiag = panel.querySelector('#sihs-copy-diag');
        if ($copyDiag) {
            $copyDiag.addEventListener('click', async () => {
                const text = await runSelfCheck();
                try {
                    await navigator.clipboard.writeText(text);
                    showToast('info', '诊断已复制，粘贴发给暮蝶');
                } catch (e) {
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        showToast('info', '诊断已复制，粘贴发给暮蝶');
                    } catch (e2) { showToast('error', '复制失败，请点「运行自检」手动复制'); }
                }
            });
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

    async function updateSettingsStatus() {
        const panel = getSettingsPanel();
        if (!panel) return;
        const $disp = panel.querySelector('#sihs-status-display');
        const $disp2 = panel.querySelector('#sihs-status-display-2');
        const $disp3 = panel.querySelector('#sihs-status-display-3');
        try {
            const context = getContext();
            const role = context ? resolveCurrentChatRole(context) : null;
            if (!role || !role.char) {
                if ($disp) $disp.textContent = '当前聊天角色：未识别（' + ((role && role.reason) || 'getContext 不可用') + '）';
                if ($disp2) $disp2.textContent = '已购库写入目标：未绑定（识别失败宁可空转不猜着写）';
                if ($disp3) $disp3.textContent = '';
                return;
            }
            const charName = role.name || '(无名)';
            // 只读查询：不触发 getWardrobeBook（避免状态栏刷新时副作用创建空条目）
            const { cb } = role.char ? resolveCharBook(role.char) : { cb: null };
            const hasPurchased = !!(cb && cb.entries.some((e) => e && e.comment && String(e.comment).includes('已购衣物库')));
            const b = backupFor(role);
            const n = (b && Array.isArray(b.purchasedIds)) ? b.purchasedIds.length : 0;
            const modeText = { auto: '自动(卡内货架→专属,否则→全局)', 'replace-honeymoon': '代替蜜月专属书', global: '全局书' }[shelfSourceMode] || shelfSourceMode;
            if ($disp) $disp.textContent = `当前聊天角色：${charName}；货架源：${modeText}；已购衣物库：${hasPurchased ? '已就位' : '未创建'}（${n} 款）`;
            // 闸2：手填服务器世界书名前缀 ≠ 当前角色名 → 黄条拦截提示
            let warn = `已购库写入目标：${charName}_Worldbooks`;
            try {
                const manual = String(localStorage.getItem('standInHoneyMoonSync_worldbookName_v1') || '').trim();
                if (manual && charName && !manual.startsWith(charName)) {
                    warn = `⚠ 手填服务器世界书名「${manual}」前缀与当前角色「${charName}」不符，已拦截写入，请改成 <角色名>_Worldbooks`;
                }
            } catch (e) { /* ignore */ }
            if ($disp2) $disp2.textContent = warn;
            // 第三行：货架实际对齐到哪本书/哪个卡（异步解析真实货架来源，显示"现在对齐的是哪个"）
            if ($disp3) {
                $disp3.textContent = '货架对齐中…';
                try {
                    const lm = linWanqingModeActive(role);
                    const shelf = await getShelfSource(context, role);
                    if (shelf.found) {
                        const src = (shelf.name ? '「' + shelf.name + '」' : '「(无名)」') + (shelf.mode ? '(' + shelf.mode + ')' : '');
                        $disp3.textContent = (lm.active
                            ? '林婉清模式：已激活（' + lm.reason + '）· 货架对齐当前角色专属书 ' + src + ' ✓'
                            : '林婉清模式：未激活（' + lm.reason + '）· 货架对齐全局书 ' + src + ' ✓');
                    } else {
                        $disp3.textContent = (lm.active
                            ? '林婉清模式：已激活（' + lm.reason + '）· ⚠ 货架未找到：' + (shelf.err || '')
                            : '林婉清模式：未激活（' + lm.reason + '）· ⚠ 货架未找到：' + (shelf.err || ''));
                    }
                } catch (e) {
                    $disp3.textContent = '货架对齐：查询失败（不影响监听）。';
                }
            }
        } catch (e) {
            if ($disp) $disp.textContent = '状态获取失败（不影响监听）。';
        }
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
        handleMessages(messages).catch(() => { /* 已静默 */ });
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
            const role = resolveCurrentChatRole(c);
            if (!role || !role.char) { showToast('warning', '未识别当前聊天角色'); return; }
            const ok = saveCharacterSafe(c, role.index, role.char);
            const called = diag.lastSaveMethod || '(无)';
            showToast(ok ? 'info' : 'warning', '已触发保存：' + called + (ok ? '' : '（未找到任何保存接口）'));
            setTimeout(updateSettingsStatus, 300);
            log('测试保存：调用 ' + called + '；探测到 ' + diag.lastSaveFound.join(', '));
        } catch (e) {
            showToast('error', '测试保存异常：' + (e && e.message));
        }
    }

    // 写 worldInfo 落盘测试：把已购衣物库条目更新进 context.worldInfo（若为数组）再 saveWorldInfo 落盘。
    // v1.7.0 守卫：只在 worldInfo【已含「已购衣物库」条目】时更新——已购库首次创建在角色书/服务器书里做，
    // 绝不在这里新建，防止把已购库写进全局书《暮蝶衣物库》。
    function writeWorldInfoNow() {
        try {
            const c = getContext();
            if (!c) { showToast('warning', 'getContext 不可用'); return; }
            const role = resolveCurrentChatRole(c);
            if (!role || !role.char) { showToast('warning', '未识别当前聊天角色'); return; }

            // 1) 找已购库 content（当前角色自己的世界书里的）
            const wb = getWardrobeBook(role);
            if (!wb.entry) { showToast('error', '当前角色没有「已购衣物库」条目（' + (wb.err || '') + '），先买一件或点立即同步'); return; }
            const content = wb.entry.content || '';

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
                const hasPur = c.worldInfo.some((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
                lines.push('worldInfo 含已购库: ' + (hasPur ? '是' : '否'));
                if (!hasPur) {
                    // 守卫：worldInfo 没有已购库条目 → 不是扩展维护过的角色书/是全局书，不新建、不写入
                    lines.push('worldInfo 不含「已购衣物库」条目 → 不写入（已购库首次创建在角色书/服务器角色名_Worldbooks，避免污染全局书）');
                    writeWorldInfoResult(lines);
                    return;
                }
            }

            // 3) 塞进去（守卫：syncToActiveWorld 只更新已含已购库的书）
            let wrote = false;
            if (Array.isArray(c.worldInfo)) {
                wrote = syncToActiveWorld(c, content);
            } else if (c.worldInfo && typeof c.worldInfo === 'object') {
                const arrCandidates = [c.worldInfo.entries, c.worldInfo.data, c.worldInfo.world_info];
                for (const arr of arrCandidates) {
                    if (Array.isArray(arr) && arr.some((e) => e && e.comment && String(e.comment).includes('已购衣物库'))) {
                        const entry = arr.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
                        if (entry) { entry.content = content; wrote = true; break; }
                    }
                }
                if (!wrote) lines.push('worldInfo 对象里没有含已购库的条目数组，未写入');
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

    // --- 服务器世界书（真落盘路，从 Chloe fork 源码摸清） ---
    // 平台服务器世界书（世界书编辑台/模型读的就是它）：
    //   读  POST /api/worldinfo/get { name }           → 整本书 { entries: { [uid]: entry }, ... }
    //   写  POST /api/worldinfo/edit { name, data }    → data 必须含 entries（整本书对象）
    //   列  POST /api/settings/get                     → world_names 数组
    // 标准酒馆同款路由，本地也通用。注意：没有 /api/worldinfo/all、没有 /create——之前 404 就死在这。
    async function serverApi(method, path, body) {
        let headers = { 'Content-Type': 'application/json' };
        try {
            const ctx = getContext();
            // 取请求头：优先顶层 getRequestHeaders（本云平台挂在 getContext 顶层），
            // 再试标准酒馆的 common.getRequestHeaders（带 CSRF token），都没有就只带 Content-Type。
            // ⚠ 关键：merge 回来的头一律强制盖上 Content-Type，否则云平台可能拒收 JSON body。
            if (ctx && typeof ctx.getRequestHeaders === 'function') {
                const h = ctx.getRequestHeaders();
                if (h && typeof h === 'object') headers = Object.assign({}, h, { 'Content-Type': 'application/json' });
            } else if (ctx && ctx.common && typeof ctx.common.getRequestHeaders === 'function') {
                const h = ctx.common.getRequestHeaders();
                if (h && typeof h === 'object') headers = Object.assign({}, h, { 'Content-Type': 'application/json' });
            }
        } catch (e) { /* ignore */ }
        const opts = { method, headers };
        if (body !== undefined) opts.body = JSON.stringify(body);
        return await fetch('/api/worldinfo/' + path, opts);
    }

    // 读服务器书；entries 归一化成 uid 键控对象返回
    async function serverGetBook(name) {
        try {
            const res = await serverApi('POST', 'get', { name });
            if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
            const data = await res.json().catch(() => null);
            if (!data || data.entries === undefined) return { ok: false, err: '返回无 entries' };
            return { ok: true, book: data };
        } catch (e) {
            return { ok: false, err: String((e && e.message) || e) };
        }
    }

    // 世界书名字列表（POST /api/settings/get → world_names）
    async function serverWorldNames() {
        try {
            let headers = { 'Content-Type': 'application/json' };
            const ctx = getContext();
            if (ctx && typeof ctx.getRequestHeaders === 'function') {
                const h = ctx.getRequestHeaders();
                if (h && typeof h === 'object') headers = Object.assign({}, h, { 'Content-Type': 'application/json' });
            }
            const res = await fetch('/api/settings/get', { method: 'POST', headers, body: JSON.stringify({}) });
            if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
            const data = await res.json().catch(() => null);
            const names = (data && Array.isArray(data.world_names)) ? data.world_names : [];
            return { ok: true, names };
        } catch (e) {
            return { ok: false, err: String((e && e.message) || e) };
        }
    }

    // 世界书 entries 归一化：服务器文件里是 { uid: entry }；兼容老数组格式
    function entriesToMap(entries) {
        if (Array.isArray(entries)) {
            const map = {};
            for (const e of entries) { if (e && e.uid !== undefined) map[e.uid] = e; }
            return map;
        }
        return entries || {};
    }
    function entriesList(book) {
        return Object.values(entriesToMap(book && book.entries));
    }
    function findEntryByComment(book, kw) {
        const list = entriesList(book);
        return list.find((e) => e && String(e.comment || '').includes(kw)) || null;
    }
    function nextFreeUid(book) {
        const map = entriesToMap(book && book.entries);
        for (let i = 0; i < 1000000; i++) if (!(i in map)) return i;
        return null;
    }

    // 宽容提取已购库编号集合：兼容 泳【泳01】/【泳01】/行首 泳01（旧卡全文式可能没有前导分类）等格式，
    // 统一归一化成 泳01。回读验证用这个，避免服务器旧格式不同导致误判「写入未生效」。
    function extractIndexIds(content) {
        const ids = [];
        const seen = new Set();
        const s = content || '';
        // 格式1: 泳【泳01】 / 【泳01】——从【】里拿分类+数字
        let m;
        const re1 = /【([泳睡日内礼])(\d{2})】/g;
        while ((m = re1.exec(s)) !== null) {
            const id = m[1] + m[2];
            if (!seen.has(id)) { seen.add(id); ids.push(id); }
        }
        // 格式2: 行首 泳01 / 泳01 款式名（旧式无【】包裹）
        const re2 = /(?:^|\n)[ \t]*([泳睡日内礼])(\d{2})\b/g;
        while ((m = re2.exec(s)) !== null) {
            const id = m[1] + m[2];
            if (!seen.has(id)) { seen.add(id); ids.push(id); }
        }
        return ids;
    }

    // 书名解析缓存：避免自动链路每轮全量扫书
    let resolvedBookName = '';
    let resolvedBookNameAt = 0;

    // 某书是否含「可购买衣物库」条目
    async function bookHasShelf(name) {
        const r = await serverGetBook(name);
        return !!(r.ok && findEntryByComment(r.book, '可购买衣物库'));
    }

    // 定位服务器上含「可购买衣物库」的世界书
    // 顺序：设置里手填的书名 → <角色名>_Worldbooks → <角色名> → 全量扫
    async function resolveServerBookName(charName) {
        const now = Date.now();
        if (resolvedBookName && (now - resolvedBookNameAt) < 60000) return resolvedBookName;
        let manual = '';
        try { manual = String(localStorage.getItem('standInHoneyMoonSync_worldbookName_v1') || '').trim(); } catch (e) { /* ignore */ }
        const candidates = [];
        if (manual) candidates.push(manual);
        if (charName) { candidates.push(charName + '_Worldbooks', charName); }
        for (const name of candidates) {
            try { if (await bookHasShelf(name)) { resolvedBookName = name; resolvedBookNameAt = now; return name; } } catch (e) { /* ignore */ }
        }
        // 全量扫：世界书列表里逐本找
        const all = await serverWorldNames();
        if (all.ok) {
            for (const name of all.names) {
                try { if (await bookHasShelf(name)) { resolvedBookName = name; resolvedBookNameAt = now; return name; } } catch (e) { /* ignore */ }
            }
        }
        resolvedBookName = '';
        resolvedBookNameAt = now;
        return null;
    }

    // 已购库写入目标服务器书（v1.7.0）：永远当前角色自己的书（<角色名>_Worldbooks）。
    // 闸2：手填书名前缀 ≠ 当前角色名 → 拦截（返回 blocked 原因，绝不写别人的书/全局书）。
    // 返回 { book, blocked }；book 为服务器上实际存在的角色书，不存在则 book=null。
    async function resolveWardrobeBookName(charName) {
        let manual = '';
        try { manual = String(localStorage.getItem('standInHoneyMoonSync_worldbookName_v1') || '').trim(); } catch (e) { /* ignore */ }
        if (manual) {
            if (charName && !manual.startsWith(charName)) {
                return { book: null, blocked: '手填服务器世界书名「' + manual + '」前缀与当前角色「' + charName + '」不符，已拦截写入' };
            }
            const r = await serverGetBook(manual);
            if (r.ok) return { book: manual, blocked: '' };
            return { book: null, blocked: '手填服务器世界书「' + manual + '」在服务器上不存在' };
        }
        if (!charName) return { book: null, blocked: '未识别当前聊天角色' };
        const auto = charName + '_Worldbooks';
        const r = await serverGetBook(auto);
        if (r.ok) return { book: auto, blocked: '' };
        return { book: null, blocked: '服务器上无当前角色的世界书（' + auto + ' 不存在；已存本地备份，导出卡可转移）' };
    }

    // 通知前端世界书缓存与编辑台刷新（让界面即时显示，不用手动刷新页面）。
    // Chloe 平台自己的保存会 worldInfoCache.set + emit WORLDINFO_UPDATED；
    // 扩展直接 POST edit 绕过了这步，这里补上：缓存更新 + 事件 + 编辑器重渲染，全防御式。
    // openEditor=true：强制把书载进编辑台（手动按钮场景，用户要看结果）；
    // openEditor=false：仅当编辑台正开这本书才刷新（自动链路，不打断聊天）。
    async function notifyWorldInfoRefreshed(bookName, book, openEditor) {
        const actions = [];
        try {
            const ctx = getContext();
            // ① 平台缓存更新 + 事件（保存为整本书对象；平台会更新 worldInfoCache 并触发自身事件）
            if (bookName && book && ctx && typeof ctx.saveWorldInfo === 'function') {
                try { ctx.saveWorldInfo(bookName, book); actions.push('saveWorldInfo'); } catch (e) { /* ignore */ }
            }
            // ② 世界书列表刷新：reloadEditor 依赖 world_names，必须先等它填充完成
            if (ctx && typeof ctx.updateWorldInfoList === 'function') {
                try { await ctx.updateWorldInfoList(); actions.push('updateWorldInfoList'); } catch (e) { /* ignore */ }
            }
            // ③ 编辑台重载：reloadEditor(文件名, loadIfNotSelected) 必须传书名才有意义
            //    （无参调用时内部 world_names.indexOf(undefined) = -1，直接 no-op——之前就死在这）
            if (bookName && ctx && typeof ctx.reloadWorldInfoEditor === 'function') {
                try { ctx.reloadWorldInfoEditor(bookName, openEditor === true); actions.push('reloadEditor(' + bookName + ')'); } catch (e) { /* ignore */ }
            }
            // ④ 兜底 emit 平台事件（若无监听也无害）
            const es = (window.SillyTavern && window.SillyTavern.eventSource) || window.eventSource;
            const et = (window.SillyTavern && window.SillyTavern.event_types) || window.event_types;
            if (es && et && et.WORLDINFO_UPDATED && typeof es.emit === 'function') {
                try { es.emit(et.WORLDINFO_UPDATED, bookName, book); actions.push('emit WORLDINFO_UPDATED'); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
        return actions;
    }

    // 把「已购衣物库」content 写入服务器世界书（POST get → 改 entries → POST edit）。
    // v1.7.0：写目标永远是当前角色自己的书（角色名_Worldbooks，闸2 前缀校验拦截），绝不写全局《暮蝶衣物库》；
    // 已购库 content 为索引式（编号+款式名一行），回读验证用索引集合比对（比长度更稳）。
    // openEditor=true：写完把书载进编辑台（手动按钮，即时显示）；false/缺省：不打断聊天（自动链路）。
    // 返回 { ok, lines }；不弹 toast，结果进 diag，失败静默（本地备份兜底）。
    async function syncServerPurchased(content, ids, openEditor, role) {
        const lines = [];
        const n = Array.isArray(ids) ? ids.length : 0;
        lines.push('已购库索引 ' + (content ? content.length : 0) + ' 字，' + n + ' 款');
        try {
            const context = getContext();
            const r = role || (context ? resolveCurrentChatRole(context) : null);
            if (!r || !r.char) { lines.push('未识别当前聊天角色，跳过服务器写入'); return { ok: false, lines }; }
            const charName = r.name || charNameKey(r.char);
            const wb = await resolveWardrobeBookName(charName);
            const bookName = wb.book;
            if (wb.blocked || !bookName) {
                lines.push(wb.blocked || '未定位到当前角色的服务器世界书');
                return { ok: false, lines };
            }
            lines.push('目标服务器书: ' + bookName);
            const rg = await serverGetBook(bookName);
            if (!rg.ok) { lines.push('读书失败: ' + rg.err); return { ok: false, lines }; }
            const book = rg.book;
            const entries = entriesToMap(book.entries);
            const shelfE = findEntryByComment(book, '可购买衣物库');
            let pur = findEntryByComment(book, '已购衣物库');
            if (!pur) {
                // 照可购买库条目克隆字段（cloneKeyField：全局书用 key、代替蜜月用 keys），换 uid/comment/content
                const uid = nextFreeUid(book);
                if (uid === null) { lines.push('分配 uid 失败'); return { ok: false, lines }; }
                pur = Object.assign({}, shelfE || {}, {
                    uid,
                    comment: '已购衣物库',
                    content: content || '',
                    key: cloneKeyField(shelfE),
                });
                entries[uid] = pur;
                lines.push('新建「已购衣物库」条目 (uid=' + uid + ')');
            } else {
                pur.content = content || '';
                lines.push('更新「已购衣物库」条目 (uid=' + pur.uid + ')');
            }
            book.entries = entries;
            const save = await serverApi('POST', 'edit', { name: bookName, data: book });
            lines.push('edit 落盘: HTTP ' + save.status);
            // 刷新前端世界书缓存/编辑台（即时显示，不用手动刷新页面）
            const refresh = await notifyWorldInfoRefreshed(bookName, book, openEditor);
            if (refresh.length) lines.push('已通知前端刷新: ' + refresh.join(' + '));
            else lines.push('（未找到前端刷新接口，编辑台如未更新需刷新页面）');
            // 回读验证：宽容编号提取 + 覆盖语义。
            // 老大要「新卡覆盖旧卡记录」：本地已无条件用本地索引覆盖了服务器已购库 content（见上）。
            // 回读只做「确认」：服务器能提取到编号且与本地一致 → 覆盖成功；提取不到（旧格式/未写入）→ 提示确认，不吓人判失败。
            const v = await serverGetBook(bookName);
            if (v.ok) {
                const vp = findEntryByComment(v.book, '已购衣物库');
                if (!vp) {
                    lines.push('回读: 服务器上没有「已购衣物库」条目 ⚠（edit 可能未生效，F12 跑 inspectServerBook 查看）');
                    return { ok: false, lines };
                }
                const srvIds = extractIndexIds(vp.content || '');
                const srvSet = new Set(srvIds);
                const localSet = new Set(Array.isArray(ids) ? ids : []);
                lines.push('服务器回读已购库: ' + ((vp.content || '').length) + ' 字，提取编号 ' + (srvIds.length ? srvIds.join(',') : '(空)'));
                if (srvIds.length === 0 && localSet.size > 0) {
                    // 服务器旧格式（无【】/无编号）或未写入：本地已按覆盖写回，提示确认，不判写入失败
                    lines.push('回读验证: 服务器已购库无编号（旧卡格式或未写入）——本地已按「新卡覆盖旧卡」写回 ' + localSet.size + ' 款。若服务器仍未更新，F12 跑 window.__sihsDebug.inspectServerBook() 查看实际内容');
                    return { ok: true, lines };
                }
                const missing = Array.from(localSet).filter((x) => !srvSet.has(x));
                const extra = Array.from(srvSet).filter((x) => !localSet.has(x));
                if (!missing.length && !extra.length) {
                    lines.push('回读验证: 已购库覆盖一致 ✓（' + localSet.size + ' 款）');
                    return { ok: localSet.size > 0, lines };
                }
                lines.push('回读验证: 与本地不一致（服务器缺 ' + (missing.length ? missing.join(',') : '(无)') + ' / 服务器多 ' + (extra.length ? extra.join(',') : '(无)') + '）——已按本地覆盖写入，服务器多余旧记录未清，请确认');
                return { ok: false, lines };
            }
            lines.push('回读验证失败: ' + v.err);
            return { ok: false, lines };
        } catch (e) {
            lines.push('异常: ' + String((e && e.message) || e));
            return { ok: false, lines };
        }
    }

    // 按钮：把已购衣物库写到服务器世界书（手动兜底 + 验证）。写目标 = 当前角色自己的书（角色名_Worldbooks）。
    async function writeServerWorldInfoNow() {
        const lines = ['【已购库写入服务器世界书】'];
        try {
            const c = getContext();
            const role = c ? resolveCurrentChatRole(c) : null;
            if (!role || !role.char) { lines.push('未识别当前聊天角色'); writeServerResult(lines); return; }
            const wb = getWardrobeBook(role);
            const b = backupFor(role);
            const content = (b && b.content) || (wb.entry && wb.entry.content);
            if (!content) { lines.push('没有已购库内容（先买一件，或点立即同步）'); writeServerResult(lines); return; }
            const ids = (b && Array.isArray(b.purchasedIds)) ? b.purchasedIds : [];
            // openEditor=true：按钮场景，写完把书载进编辑台即时显示
            const r = await syncServerPurchased(content, ids, true, role);
            lines.push(...r.lines);
            if (!r.ok) lines.push('写入未完成——详见上方结果');
        } catch (e) {
            lines.push('异常: ' + String((e && e.message) || e));
        }
        writeServerResult(lines);
    }

    // 一键清空已购库（从零开始）：清本地该角色备份键 + 服务器已购库条目重置为空白模板（无索引行）。
    // 用于「新卡不该继承旧卡已购记录」的场景——旧 10 款来自本地备份命中（同名同指纹），清掉后新卡从 0 记。
    // 返回 { ok, lines }；不弹 toast，结果进 diag。
    async function resetPurchasedNow() {
        const lines = ['【清空已购记录（从零开始）】'];
        const c = getContext();
        const role = c ? resolveCurrentChatRole(c) : null;
        if (!role || !role.char) { lines.push('未识别当前聊天角色'); return { ok: false, lines }; }
        const name = role.name || charNameKey(role.char);
        // ① 清本地备份键（角色名::指纹 + 旧纯名键）
        try {
            const map = loadBackup();
            const key = roleBackupKey(role.char, name);
            let cleared = 0;
            if (map[key]) { delete map[key]; cleared++; }
            if (map[name]) { delete map[name]; cleared++; }
            saveBackup(map);
            lines.push('本地备份已清: ' + (cleared ? ('删除键 ' + key + (name !== key ? (' + ' + name) : '')) : '（无该角色备份，本就干净）'));
        } catch (e) { lines.push('本地备份清理异常: ' + String((e && e.message) || e)); }
        // ② 清当前角色卡本地已购库条目（内存 + 世界书），重置为空白模板
        try {
            const wb = getWardrobeBook(role);
            if (wb.entry && wb.cb) {
                const e = wb.entry;
                const had = (e.content || '').match(/[泳睡日内礼]【[泳睡日内礼]\d{2}】/g) || [];
                e.content = PURCHASED_TEMPLATE;
                // 同步进活跃世界书/编辑器活动书（守卫：只有已含已购库的书才更新）
                if (Array.isArray(c.worldInfo) && c.worldInfo.some((x) => x && x.comment && String(x.comment).includes('已购衣物库'))) {
                    try { syncToActiveWorld(c, PURCHASED_TEMPLATE); } catch (e2) { /* ignore */ }
                }
                try { syncToEditorState(c, PURCHASED_TEMPLATE); } catch (e2) { /* ignore */ }
                saveCharacterSafe(c, role.index, role.char);
                lines.push('角色卡本地已购库已重置为空白模板（清掉 ' + (had.length || 0) + ' 款索引）');
            } else {
                lines.push('角色卡本地无已购库条目（无需重置）');
            }
        } catch (e) { lines.push('角色卡本地重置异常: ' + String((e && e.message) || e)); }
        // ③ 服务器：读当前角色书 → 已购库条目重置为空白模板 → edit 写回 → 回读
        try {
            const wbName = await resolveWardrobeBookName(name);
            const bookName = wbName.book;
            if (!bookName) { lines.push('服务器: ' + (wbName.blocked || '未定位当前角色世界书，跳过（本地已清）')); return { ok: true, lines }; }
            const rg = await serverGetBook(bookName);
            if (!rg.ok) { lines.push('服务器读书失败: ' + rg.err); return { ok: false, lines }; }
            const book = rg.book;
            const entries = entriesToMap(book.entries);
            const pur = findEntryByComment(book, '已购衣物库');
            if (!pur) { lines.push('服务器书里没有「已购衣物库」条目，无需清'); return { ok: true, lines }; }
            const had = (pur.content || '').match(/[泳睡日内礼]【[泳睡日内礼]\d{2}】/g) || [];
            pur.content = PURCHASED_TEMPLATE;
            book.entries = entries;
            const save = await serverApi('POST', 'edit', { name: bookName, data: book });
            lines.push('服务器 edit 落盘: HTTP ' + save.status + '（清掉 ' + (had.length || 0) + ' 款索引）');
            await notifyWorldInfoRefreshed(bookName, book, false);
            const v = await serverGetBook(bookName);
            if (v.ok) {
                const vp = findEntryByComment(v.book, '已购衣物库');
                const n = vp ? extractIndexIds(vp.content || '').length : -1;
                lines.push('服务器回读已购库编号数: ' + (n >= 0 ? n : '(条目缺失)'));
                return { ok: n === 0, lines };
            }
            lines.push('服务器回读失败: ' + v.err);
            return { ok: false, lines };
        } catch (e) {
            lines.push('服务器清理异常: ' + String((e && e.message) || e));
            return { ok: false, lines };
        }
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
            const role = resolveCurrentChatRole(c);
            if (!role || !role.char) { showToast('warning', '未识别当前聊天角色'); return; }
            const { cb } = ensureCharBook(role.char);
            if (!cb) { showToast('error', '目标角色无世界书 data.character_book'); return; }
            // 先把最近的聊天扫一遍（有购买则追加 + 写备份），保证导出的已购库是最新
            try {
                const chat = Array.isArray(c.chat) ? c.chat.slice(-8) : [];
                handleMessages(chat).catch(() => { /* 已静默 */ });
            } catch (e) { /* ignore */ }
            // 从备份刷新已购库 content（备份总是最新落点）
            const b = backupFor(role);
            if (b && b.content) {
                const pur = cb.entries.find((e) => e && e.comment && String(e.comment).includes('已购衣物库'));
                if (pur) {
                    pur.content = b.content;
                } else {
                    const built = buildNewPurchasedEntry(role.char, b.content);
                    if (built) cb.entries.push(built);
                }
            }
            // 拼 v3 卡壳
            const data = (role.char.data && typeof role.char.data === 'object') ? role.char.data : role.char;
            data.character_book = cb;
            const card = { spec: 'chara_card_v3', spec_version: '2.0', data };
            const json = JSON.stringify(card, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            let ts = '';
            try { ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); } catch (e) { ts = 'card'; }
            a.href = url;
            a.download = (role.name || '角色') + '_已购库' + ts + '.json';
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
            const role = c ? resolveCurrentChatRole(c) : null;
            if (!role || !role.char) {
                lines.push('当前聊天角色: 未识别（' + ((role && role.reason) || 'getContext 不可用') + '）——宁可空转不猜着写');
            } else {
                lines.push('当前聊天角色: ' + (role.name || '(无名)') + (role.fingerprint ? ('（指纹: ' + role.fingerprint + '）') : ''));
                lines.push('角色下标: ' + role.index + '（characterId=' + c.characterId + '，' + (String(role.index) === String(c.characterId) ? '一致' : '不一致 ← 关注') + '）');
                const idChar = ((typeof c.characterId === 'number' || typeof c.characterId === 'string') && Array.isArray(c.characters) && c.characters[Number(c.characterId)]) ? c.characters[Number(c.characterId)] : null;
                lines.push('characterId 指向: ' + (idChar ? (idChar.name || (idChar.data && idChar.data.name) || '(无名)') : '(无)'));
                lines.push('货架读取源模式: ' + shelfSourceMode + '（auto=当前角色卡内含「可购买衣物库」→专属书，否则→全局书）');
                // 货架源（异步读：auto→角色书/全局书；全局书只读不建）
                const shelfSrc = await getShelfSource(c, role);
                lines.push('货架来源: ' + (shelfSrc.found
                    ? ('「' + shelfSrc.name + '」(' + shelfSrc.mode + ') ' + (shelfSrc.content ? shelfSrc.content.length : 0) + ' 字')
                    : ('未找到——' + (shelfSrc.err || ''))));
                // 已购库写入目标（闸1：永远当前角色自己的世界书）
                const wb = getWardrobeBook(role);
                const wbPath = wb.path || '';
                lines.push('已购库写入目标: ' + (wb.entry ? ('当前角色世界书（' + wbPath + '）已就位') : ('不可用（' + (wb.err || '') + '）')));
                diag.charPath = wbPath;
                const shelf = shelfSrc.found ? { content: shelfSrc.content } : null;
                const entries = (wb.cb && wb.cb.entries) || [];
                lines.push('entries 总数: ' + entries.length);
                lines.push('可购买库(货架): ' + (shelf ? '有（' + (shelf.content ? shelf.content.length : 0) + ' 字）' : '无'));
                const pur = wb.entry;
                lines.push('已购衣物库(内存): ' + (pur ? '已创建（' + (pur.content ? pur.content.length : 0) + ' 字）' : '无'));
                // 已购编号记账集合（来自本地备份，模型读不到）
                const curBackup = backupFor(role);
                const curIds = (curBackup && Array.isArray(curBackup.purchasedIds)) ? curBackup.purchasedIds : [];
                lines.push('已购编号记账: ' + (curIds.length ? curIds.join('、') : '(空，从空开始)'));
                if (pur && pur.content) {
                    lines.push('内存已购库含泳03(记账): ' + (curIds.includes('泳03') ? '是' : '否'));
                    lines.push('内存已购库款式数: ' + curIds.length);
                    // 索引格式检查（v1.7.0 索引式：无行首【款式外观】等完整设定段；模板声明里的字样不算）
                    const isIndex = !/^【款式外观】|^【实际结构】|^【动态反应】/m.test(pur.content);
                    lines.push('已购库格式: ' + (isIndex ? '索引式 ✓' : '⚠ 旧全文格式（加载时自动迁移为索引式）'));
                    const idxLines = (pur.content.match(/[泳睡日内礼]【[泳睡日内礼]\d{2}】/g) || []).length;
                    lines.push('已购库索引行数: ' + idxLines);
                }

                // 购买链路测试：对当前货架跑一条标准购买消息
                if (shelf && shelf.content) {
                    lines.push('[购买链路测试]');
                    const titles = parseShelfTitles(shelf.content);
                    lines.push('可购买库款式总数: ' + titles.length);
                    const sample = '我要买泳03';
                    const hits = analyzeMessage(sample, titles);
                    if (hits.length) {
                        const t0 = titles.find((x) => x.id === hits[0].id);
                        lines.push('发 "' + sample + '" → 命中 ' + hits[0].id + '（' + (t0 ? t0.title : '?') + '）→ 会登记索引 ✓');
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
            const b = (role && role.char) ? backupFor(role) : null;
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
                const charName = (role && role.name) || '';
                const bookName = await resolveServerBookName(charName);
                lines.push('  读源: 定位到含「可购买衣物库」的书: ' + (bookName || '(未找到)'));
                if (bookName) {
                    const r = await serverGetBook(bookName);
                    if (r.ok) {
                        const list = entriesList(r.book);
                        const hasPur = list.some((e) => e && String(e.comment || '').includes('已购衣物库'));
                        const shelfE = findEntryByComment(r.book, '可购买衣物库');
                        lines.push('  ' + bookName + '：' + list.length + ' 条' + (hasPur ? ' [含已购库]' : ''));
                        if (shelfE && shelfE.content) lines.push('    可购买库内容长度: ' + shelfE.content.length + ' 字, uid=' + shelfE.uid);
                        if (hasPur) {
                            const pur = findEntryByComment(r.book, '已购衣物库');
                            lines.push('    服务器已购库: content ' + (pur.content || '').length + ' 字');
                        }
                    } else {
                        lines.push('  读书失败: ' + r.err);
                    }
                }
                // 写目标（当前角色自己的书，闸2 前缀校验）
                if (role && role.char) {
                    const wtarget = await resolveWardrobeBookName((role.name) || '');
                    lines.push('  写目标: ' + (wtarget.book ? wtarget.book : ('无（' + (wtarget.blocked || '') + '）')));
                }
                const all = await serverWorldNames();
                lines.push('  世界书列表(POST /api/settings/get): ' + (all.ok ? (all.names.length + ' 本: ' + all.names.join(', ')) : '失败 ' + all.err));
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
                // 调试：切换货架读取源（测试用；设置面板改动走 localStorage + 事件）
                setShelfSource: (m) => { shelfSourceMode = (m === 'replace-honeymoon' || m === 'global') ? m : 'auto'; return shelfSourceMode; },
                // 调试：宽容编号提取（回读验证用它，测试 + 老大诊断都能用）
                extractIndexIds,
                // 调试：一键清空已购记录（从零开始）——清本地备份键 + 服务器已购库重置空白模板
                resetPurchased: resetPurchasedNow,
                // 调试：货架实际对齐到哪本书（状态栏第三行「货架对齐」的数据源）
                getShelfInfo: async () => {
                    const c = getContext();
                    const role = c ? resolveCurrentChatRole(c) : null;
                    if (!role || !role.char) return { found: false, err: '未识别当前聊天角色' };
                    const s = await getShelfSource(c, role);
                    return { found: s.found, name: s.name, mode: s.mode, err: s.err || '' };
                },
                // 调试：只读检查服务器上当前角色书的「已购衣物库」条目真实状态
                // （F12 跑 await window.__sihsDebug.inspectServerBook() —— 定位「写入未生效还是格式不认」）
                inspectServerBook: async (bookName) => {
                    const out = { bookName: bookName || '', notes: [], entriesType: '', uid12: null, contentLength: 0, contentPreview: '', indexIds: [], allComments: [], error: '' };
                    const c = getContext();
                    const role = c ? resolveCurrentChatRole(c) : null;
                    if (!out.bookName && role && role.name) {
                        try { const mn = String(localStorage.getItem('standInHoneyMoonSync_worldbookName_v1') || '').trim(); out.bookName = mn; } catch (e) { /* ignore */ }
                        if (!out.bookName) {
                            const r = await resolveWardrobeBookName(role.name);
                            out.bookName = r.book || (r.blocked || '');
                            out.notes.push('未手填书名，自动解析 → ' + (out.bookName || '未定位'));
                        }
                    }
                    if (!out.bookName) { out.error = '无目标服务器书名（未手填且未识别角色）'; return out; }
                    const rg = await serverGetBook(out.bookName);
                    if (!rg.ok) { out.error = '读书失败: ' + rg.err; return out; }
                    const book = rg.book;
                    out.entriesType = Array.isArray(book.entries)
                        ? '数组(' + book.entries.length + '条)'
                        : (book.entries && typeof book.entries === 'object' ? '对象map(uid键, ' + Object.keys(book.entries).length + '条)' : String(typeof book.entries));
                    const pur = findEntryByComment(book, '已购衣物库');
                    if (!pur) { out.error = '书里没有「已购衣物库」条目（只有可购买库等）'; out.allComments = entriesList(book).map((e) => String(e.comment || '')).slice(0, 30); return out; }
                    out.uid12 = pur.uid;
                    out.contentLength = (pur.content || '').length;
                    out.contentPreview = (pur.content || '').slice(0, 300);
                    out.indexIds = extractIndexIds(pur.content || '');
                    out.allComments = entriesList(book).map((e) => String(e.comment || '')).slice(0, 30);
                    return out;
                },
                testSave: testSaveNow,
                // 测试任意购买消息：返回命中+索引行结果（不改任何数据）。货架按当前读取源（auto/专属/全局）解析。
                testPurchase: async (text) => {
                    const c = getContext();
                    const role = c ? resolveCurrentChatRole(c) : null;
                    if (!role || !role.char) return '未识别当前聊天角色';
                    const shelf = await getShelfSource(c, role);
                    if (!shelf.found) return '货架未找到：' + (shelf.err || '');
                    const titles = parseShelfTitles(shelf.content);
                    const hits = analyzeMessage(text || '', titles);
                    if (!hits.length) return '未命中（text=' + JSON.stringify(text) + '）';
                    return hits.map((h) => {
                        const t = titles.find((x) => x.id === h.id);
                        const line = h.cat + '【' + h.id + '】' + (t ? t.title : '?');
                        return h.id + '(' + h.by + ') 索引行: ' + line;
                    }).join('; ');
                },
            };
        } catch (e) { /* ignore */ }
    }

    function init() {
        migrateBackupV2(); // 清旧 v1 备份（含编号+预置款式），从空开始
        installRequestHook(); // 先装保存请求拦截，越早越好
        loadExtensionEnabled();
        loadShelfSource(); // 货架读取源（auto/replace-honeymoon/global）
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
        log('扩展已加载，监听购买场景。（货架源：' + shelfSourceMode + '）');
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
