// 飞书 Base (多维表格) API 封装
// 动态读取知识库字段和记录，自适应表结构

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// 获取 tenant_access_token
async function getTenantAccessToken(appId, appSecret) {
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取飞书 token 失败: ${data.msg}`);
  }
  return data.tenant_access_token;
}

// 列出表字段（动态获取字段名和类型）
async function listFields(token, appToken, tableId) {
  const res = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取字段失败: ${data.msg}`);
  }
  return data.data.items || [];
}

// 读取所有记录（自动分页）
async function listAllRecords(token, appToken, tableId) {
  const records = [];
  let pageToken = undefined;
  do {
    const url = new URL(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`);
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`获取记录失败: ${data.msg}`);
    }
    records.push(...(data.data.items || []));
    pageToken = data.data.has_more ? data.data.page_token : undefined;
  } while (pageToken);
  return records;
}

// 将飞书记录的 cell 值提取为可读文本
function extractCellValue(field, cellValue) {
  if (cellValue === null || cellValue === undefined) return '';
  const type = field.type;
  // 1: 多行文本, 2: 数字, 3: 单选, 4: 多选, 5: 日期, 7: 复选框, 11: 人员, 13: 电话, 15: 超链接, 17: 附件, 18: 关联, 19: 查找引用, 20: 公式, 21: 双向关联, 22: 地理位置, 23: 群组, 1001: 创建时间, 1002: 修改时间, 1003: 创建人, 1004: 修改人, 1005: 自动编号
  switch (type) {
    case 1: // 多行文本
      return Array.isArray(cellValue)
        ? cellValue.map(t => (typeof t === 'string' ? t : t.text || '')).join('')
        : String(cellValue);
    case 2: // 数字
      return String(cellValue);
    case 3: // 单选
      return typeof cellValue === 'string' ? cellValue : (cellValue.text || cellValue.name || '');
    case 4: // 多选
      return Array.isArray(cellValue)
        ? cellValue.map(o => o.text || o.name || '').join('、')
        : String(cellValue);
    case 5: // 日期 (毫秒时间戳)
      if (typeof cellValue === 'number') {
        return new Date(cellValue).toISOString().split('T')[0];
      }
      return String(cellValue);
    case 7: // 复选框
      return cellValue ? '是' : '否';
    case 11: // 人员
      return Array.isArray(cellValue) ? cellValue.map(p => p.name || '').join('、') : '';
    case 13: // 电话
      return String(cellValue);
    case 15: // 超链接
      return Array.isArray(cellValue)
        ? cellValue.map(l => `${l.text || ''}(${l.link || ''})`).join('; ')
        : (cellValue.text || cellValue.link || '');
    case 18: // 关联
    case 21: // 双向关联
      return Array.isArray(cellValue) ? cellValue.map(r => r.text || r.record_id || '').join('、') : '';
    case 19: // 查找引用
    case 20: // 公式
      return Array.isArray(cellValue)
        ? cellValue.map(t => (typeof t === 'string' ? t : t.text || '')).join('')
        : String(cellValue);
    case 22: // 地理位置
      return typeof cellValue === 'object' ? (cellValue.full_address || cellValue.address || '') : String(cellValue);
    default:
      if (typeof cellValue === 'string') return cellValue;
      if (typeof cellValue === 'number') return String(cellValue);
      try { return JSON.stringify(cellValue); } catch { return ''; }
  }
}

// 主入口：读取知识库并返回可读的记录数组
async function fetchKnowledgeBase(config) {
  const { appId, appSecret, appToken, tableId } = config;
  if (!appId || !appSecret || !appToken || !tableId) {
    throw new Error('飞书知识库配置不完整，需要 appId, appSecret, appToken, tableId');
  }

  const token = await getTenantAccessToken(appId, appSecret);
  const fields = await listFields(token, appToken, tableId);
  const records = await listAllRecords(token, appToken, tableId);

  // 将记录转为 { 字段名: 值 } 的可读结构
  const fieldMap = new Map();
  fields.forEach(f => fieldMap.set(f.field_id, f));

  return records.map(record => {
    const row = {};
    if (record.fields) {
      for (const [fieldId, value] of Object.entries(record.fields)) {
        const field = fieldMap.get(fieldId) || { name: fieldId, type: 1 };
        row[field.name] = extractCellValue(field, value);
      }
    }
    return row;
  });
}

module.exports = { fetchKnowledgeBase };
