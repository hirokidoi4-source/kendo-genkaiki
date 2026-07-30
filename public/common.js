// === 【共通ファイル：common.js】 ===
// システム全体のカテゴリー規格（Single Source of Truth）

/**
 * カテゴリー表記をDB標準の英語キーに統一する正規化関数
 * @param {string} rawCategory - CSV等から入力された生のカテゴリー名
 * @returns {string} 'low_elem' | 'elem' | 'mid' | 'mid_girls' | ''
 */
function normalizeCategoryKey(rawCategory) {
    if (!rawCategory || typeof rawCategory !== 'string') return '';
    
    const trimmed = rawCategory.trim();

    // 1. 小学生低学年（1〜2年生・3年生以下など）
    if (
        trimmed === 'low_elem' ||
        trimmed.includes('低学年') ||
        trimmed.includes('2年') ||
        trimmed.includes('1年')
    ) {
        return 'low_elem';
    }

    // 2. 小学生団体（高学年・小学生代表など）
    if (
        trimmed === 'elem' ||
        trimmed.includes('小学生') ||
        trimmed.includes('高学年') ||
        trimmed.includes('小学')
    ) {
        return 'elem';
    }

    // 3. 中学生女子
    if (
        trimmed === 'mid_girls' ||
        trimmed.includes('女子') ||
        (trimmed.includes('中学生') && trimmed.includes('女'))
    ) {
        return 'mid_girls';
    }

    // 4. 中学生団体（代表・男子・全体）
    if (
        trimmed === 'mid' ||
        trimmed.includes('中学生') ||
        trimmed.includes('中学')
    ) {
        return 'mid';
    }

    // どの条件にも合致しない場合はそのまま返す（セキュリティガードが検知・遮断します）
    return trimmed;
}

// グローバルスコープ（window）に明示的に登録
if (typeof window !== 'undefined') {
    window.normalizeCategoryKey = normalizeCategoryKey;
}
