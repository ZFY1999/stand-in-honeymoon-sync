// SillyTavern 扩展：已购衣物同步 (stand-in-honeymoon-sync)
// 需求：对话中购买「可购买衣物库」的衣物后，自动追加到独立的「已购衣物库」世界书条目。
// 定稿方案（见同目录 实现须知.md）：
//   - 已购衣物做成独立世界书条目（comment="已购衣物库"），与「已有衣物库」同等地位，不塞进 id12
//   - 保留 id9 原编号（泳03/日12…），不发明新编号体系；防重复/对账按编号判
//   - 已购衣物库头部自带性质声明：不适用「已有衣物库」无色情约定，但延续「色情设定隐藏规则」
// 防误判：购买动词 + 编号 + 可购买库分类 三要素缺一不触发；试穿/只看不买不触发
// 防越权：只新建/维护「已购衣物库」这一个条目，绝不碰可购买库、已有库和其他条目
// 容错：任何异常静默返回，不打断对话

import { eventSource, event_types, getContext, saveCharacterDebounced } from "../../../script.js";

(function () {
    'use strict';

    const PREFIX = '[已购衣物同步]';

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

    // 已购衣物库初始模板（分区 + 头部声明）
    const PURCHASED_TEMPLATE = [
        '# 已购衣物库（剧情中购买获得的衣物清单）',
        '【定位】本条目记录角色在剧情中通过购物/购买流程获得的衣物，均来自「可购买衣物库」的已购款式。本条目衣物已在剧情中购买获得，可直接取用穿着，无需再走购买流程，与「已有衣物库」（出发时随行的既有衣物）相对。',
        '【性质声明】本条目衣物来自「可购买衣物库」，保留其完整设定，包括色情款的【隐藏标记】【实际结构】【动态反应】等隐藏特性。本条目【不适用】「已有衣物库」头部"无色情特性"的约定。',
        '【色情设定隐藏规则延续】角色购买、入手本条目衣物时，仍不知晓其隐藏特性（走光、透明、滑落等）；此类特性只在实际穿着后，经动作或环境（风、水、卧姿、活动）作用时才逐步显现，角色此时略感意外，不会早有预料。规则与「可购买衣物库」完全一致。',
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
        '- 本条目由扩展自动维护：购买一件追加一件，按编号防重复，只增不改不删。',
        '- 追加的款式整块保留原设定文本（款式外观/实际结构/动态反应/隐藏标记等）。',
        '',
    ].join('\n');

    function log(...args) {
        console.log(PREFIX, ...args);
    }

    // 解析单条消息的购买语境。返回 [{ cat, num, id }]。
    // 三要素：编号存在 + 购买动词存在 + 无强否定。缺一返回空数组。
    function analyzeMessage(text) {
        if (!text || typeof text !== 'string') return [];
        if (NEGATIVE_BUY_RE.test(text)) return [];
        if (!PURCHASE_VERB_RE.test(text)) return [];
        const re = itemIdRe();
        const seen = new Set();
        const result = [];
        let m;
        while ((m = re.exec(text)) !== null) {
            const cat = m[1];
            const num = m[2];
            const id = cat + num;
            if (!CATEGORY_NAMES[cat]) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            result.push({ cat, num, id });
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

    // 已购衣物库是否已存在该编号（防重复）。按块标记「泳【泳03】」判。
    function isAlreadyPurchased(purchasedContent, cat, num) {
        if (!purchasedContent) return false;
        return new RegExp(`${cat}【${cat}${num}】`).test(purchasedContent);
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
        const hasShelf = (c) =>
            c &&
            c.character_book &&
            Array.isArray(c.character_book.entries) &&
            c.character_book.entries.some((e) => e.comment && e.comment.includes('可购买衣物库'));
        const idx = typeof context.characterId === 'number' ? context.characterId : -1;
        if (idx >= 0 && hasShelf(chars[idx])) return { char: chars[idx], index: idx };
        for (let i = 0; i < chars.length; i++) {
            if (hasShelf(chars[i])) return { char: chars[i], index: i };
        }
        return null;
    }

    // 照「已有衣物库」条目拷贝字段，新建「已购衣物库」条目。
    function buildNewPurchasedEntry(char, template) {
        const model = char.character_book.entries.find(
            (e) => e.comment && e.comment.includes('已有衣物库'),
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
        char.character_book.entries.push(entry);
        return entry;
    }

    function handleMessages(messages) {
        const context = getContext();
        if (!context) return;
        const target = getTargetCharacter(context);
        if (!target) return;
        const { char, index } = target;
        const entries = char.character_book.entries;

        const shelf = entries.find((e) => e.comment && e.comment.includes('可购买衣物库'));
        if (!shelf) return; // 没有货架条目，静默返回

        // 找到或创建「已购衣物库」条目（唯一操作对象）
        let purchasedEntry = entries.find((e) => e.comment && e.comment.includes('已购衣物库'));
        if (!purchasedEntry) {
            purchasedEntry = buildNewPurchasedEntry(char, PURCHASED_TEMPLATE);
            log('创建「已购衣物库」条目');
        }

        let content = purchasedEntry.content || '';
        let changed = false;
        const added = [];

        for (const msg of messages) {
            if (!msg || typeof msg.message !== 'string') continue;
            const buys = analyzeMessage(msg.message);
            for (const b of buys) {
                if (isAlreadyPurchased(content, b.cat, b.num)) {
                    log(`跳过重复：${b.id}`);
                    continue;
                }
                const block = extractItemBlock(shelf.content, b.cat, b.num);
                if (!block) {
                    log(`在可购买库找不到 ${b.id} 的完整设定，跳过`);
                    continue;
                }
                content = appendItem(content, b.cat, block);
                changed = true;
                added.push(b.id);
            }
        }

        if (!changed) return;
        purchasedEntry.content = content;

        // 保存：target 是当前选中角色 → 用 context.saveCharacterDebounced()（最稳）；
        // 否则用带参版本存指定角色（新版酒馆支持）。
        try {
            const contextAgain = getContext();
            if (contextAgain && contextAgain.characterId === index) {
                contextAgain.saveCharacterDebounced();
            } else {
                saveCharacterDebounced(index, char);
            }
            log(`已购衣物已同步：${added.join('、')}`);
        } catch (e) {
            log('保存角色失败：', e);
        }
    }

    function onMessage(...args) {
        let messages = [];
        const chatArg = args[0];
        if (Array.isArray(chatArg) && chatArg.length) {
            const idArg = args[1];
            const idx =
                typeof idArg === 'number' && idArg >= 0 ? idArg : chatArg.length - 1;
            messages = chatArg.slice(Math.max(0, idx - 3), idx + 1);
        } else {
            const c = getContext();
            if (c && Array.isArray(c.chat)) messages = c.chat.slice(-3);
        }
        try {
            handleMessages(messages);
        } catch (e) {
            log('处理消息出错（已静默）：', e);
        }
    }

    function init() {
        if (eventSource && event_types) {
            eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);
            eventSource.on(event_types.MESSAGE_SENT, onMessage);
        }
        log('扩展已加载，监听购买场景。');
    }

    init();
})();
