<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAgentStore } from '@/store/agent';
import { isSameEndpoint } from './agent-endpoint';

const { t } = useI18n();

const store = useAgentStore();
const local = ref({
  agentEnabled: false,
  agentAutoDraft: false,
  agentPersona: '',
  agentProvider: 'workers-ai',
  agentCfAccountId: '',
  agentAiGatewayId: '',
  agentGatewayProvider: 'openai',
  agentBaseUrl: '',
  agentApiKey: '',
  agentModel: '',
});

const saving = ref(false);
const fetchingModels = ref(false);
const testingConnection = ref(false);
const testResult = ref(null);
const modelOptions = ref([]);
const clearApiKeyRequested = ref(false);
const endpointChanged = computed(() => {
  return !isSameEndpoint(local.value, store.settings);
});

function onClearApiKey() {
  local.value.agentApiKey = '';
  clearApiKeyRequested.value = true;
  ElMessage.info(t('aiAgentKeyMarkedForClear'));
}

const selectedGatewayType = ref('openai');
const customGatewayName = ref('');

const gatewayProviderPresets = [
  { value: 'openai', label: 'OpenAI (通用 / 推荐)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'groq', label: 'Groq (高速推理)' },
  { value: 'mistral', label: 'Mistral AI' },
  { value: 'workers-ai', label: 'Cloudflare Workers AI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: 'Custom (自定义，以 custom- 开头)' },
];

function initGatewayProviderState() {
  const current = (local.value.agentGatewayProvider || '').trim();
  const presetValues = ['openai', 'anthropic', 'groq', 'mistral', 'workers-ai', 'deepseek'];
  if (presetValues.includes(current)) {
    selectedGatewayType.value = current;
    customGatewayName.value = '';
  } else if (current) {
    selectedGatewayType.value = 'custom';
    customGatewayName.value = current.startsWith('custom-') ? current : `custom-${current}`;
    local.value.agentGatewayProvider = customGatewayName.value;
  } else {
    selectedGatewayType.value = 'openai';
    local.value.agentGatewayProvider = 'openai';
    customGatewayName.value = '';
  }
}

onMounted(async () => {
  if (!store.hydrated) await store.hydrate();
  local.value = { ...store.settings };

  initGatewayProviderState();

  // If a model is already configured, ensure it is in the dropdown options
  if (local.value.agentModel) {
    modelOptions.value = [{ id: local.value.agentModel, name: local.value.agentModel }];
  }

  // Pre-load model list for workers-ai if selected
  if (local.value.agentProvider === 'workers-ai') {
    onFetchModels(false);
  }
});

function onProviderChange(val) {
  testResult.value = null;
  if (val === 'workers-ai') {
    local.value.agentModel = '@cf/moonshotai/kimi-k2.5';
    onFetchModels(false);
  } else if (val === 'cf-ai-gateway') {
    initGatewayProviderState();
    if (!local.value.agentModel || local.value.agentModel.startsWith('@cf/')) {
      local.value.agentModel = 'gpt-4o-mini';
    }
    modelOptions.value = [{ id: local.value.agentModel, name: local.value.agentModel }];
  } else if (val === 'openai-compatible') {
    if (!local.value.agentBaseUrl) local.value.agentBaseUrl = 'https://api.deepseek.com/v1';
    if (!local.value.agentModel || local.value.agentModel.startsWith('@cf/')) {
      local.value.agentModel = 'deepseek-chat';
    }
    modelOptions.value = [{ id: local.value.agentModel, name: local.value.agentModel }];
  }
}

function onGatewayTypeChange(val) {
  testResult.value = null;
  if (val === 'custom') {
    if (!customGatewayName.value || !customGatewayName.value.startsWith('custom-')) {
      customGatewayName.value = customGatewayName.value ? `custom-${customGatewayName.value.replace(/^custom-/, '')}` : 'custom-';
    }
    local.value.agentGatewayProvider = customGatewayName.value;
  } else {
    local.value.agentGatewayProvider = val;
  }
}

function onCustomGatewayNameInput(val) {
  const trimmed = (val || '').trim();
  customGatewayName.value = trimmed;
  local.value.agentGatewayProvider = trimmed;
}

function onCustomGatewayNameBlur() {
  let val = (customGatewayName.value || '').trim();
  if (val && !val.startsWith('custom-')) {
    val = 'custom-' + val;
  }
  customGatewayName.value = val;
  local.value.agentGatewayProvider = val;
}

async function onFetchModels(showMessage = true) {
  if (local.value.agentProvider === 'cf-ai-gateway' && selectedGatewayType.value === 'custom') {
    onCustomGatewayNameBlur();
  }

  fetchingModels.value = true;
  try {
    const res = await store.fetchModels({
      provider: local.value.agentProvider,
      cfAccountId: local.value.agentCfAccountId,
      aiGatewayId: local.value.agentAiGatewayId,
      gatewayProvider: local.value.agentGatewayProvider,
      baseUrl: local.value.agentBaseUrl,
      apiKey: local.value.agentApiKey,
    });
    const list = Array.isArray(res) ? res : (res?.data || []);
    modelOptions.value = list.map(m => (typeof m === 'string' ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id }));
    if (showMessage) {
      ElMessage.success(t('aiAgentModelsFetched', { count: modelOptions.value.length }));
    }
    if (!local.value.agentModel && modelOptions.value.length > 0) {
      local.value.agentModel = modelOptions.value[0].id;
    }
  } catch (e) {
    if (showMessage) {
      ElMessage.error(t('aiAgentFetchModelsFailed') + ' ' + (e?.message || e));
    }
  } finally {
    fetchingModels.value = false;
  }
}

async function onTestConnection() {
  if (local.value.agentProvider === 'cf-ai-gateway' && selectedGatewayType.value === 'custom') {
    onCustomGatewayNameBlur();
  }

  testingConnection.value = true;
  testResult.value = null;

  try {
    const res = await store.testConnection({
      provider: local.value.agentProvider,
      cfAccountId: local.value.agentCfAccountId,
      aiGatewayId: local.value.agentAiGatewayId,
      gatewayProvider: local.value.agentGatewayProvider,
      baseUrl: local.value.agentBaseUrl,
      apiKey: local.value.agentApiKey,
      model: local.value.agentModel,
    });
    const data = res?.data || res;
    testResult.value = {
      success: true,
      latencyMs: data.latencyMs,
      reply: data.reply,
    };
    ElMessage.success(t('aiAgentTestSuccessMsg', { latency: data.latencyMs }));
  } catch (e) {
    const errMsg = e?.response?.data?.message || e?.message || String(e);
    testResult.value = {
      success: false,
      error: errMsg,
    };
  } finally {
    testingConnection.value = false;
  }
}

async function save() {
  if (local.value.agentProvider === 'cf-ai-gateway' && selectedGatewayType.value === 'custom') {
    onCustomGatewayNameBlur();
    if (!customGatewayName.value || customGatewayName.value === 'custom-') {
      ElMessage.warning('请输入以 custom- 开头的 Custom Provider 名称');
      return;
    }
  }

  saving.value = true;
  try {
    const payload = { ...local.value };
    if (clearApiKeyRequested.value) {
      payload.agentApiKey = null;
    }
    await store.saveSettings(payload);
    clearApiKeyRequested.value = false;
    ElMessage.success(t('aiAgentSaved'));
  } catch (e) {
    ElMessage.error(t('aiAgentSaveFailed') + ' ' + (e.message || e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="agent-settings">
    <h2>✨ {{ $t('aiAgent') }}</h2>

    <el-form label-position="top" style="max-width: 680px;">
      <el-form-item :label="$t('aiAgentEnable')">
        <el-switch v-model="local.agentEnabled" />
        <p class="muted">{{ $t('aiAgentEnableHelp') }}</p>
      </el-form-item>

      <template v-if="local.agentEnabled">
        <!-- Provider Selection -->
        <el-form-item :label="$t('aiAgentProvider')">
          <el-select v-model="local.agentProvider" @change="onProviderChange" style="width: 100%;">
            <el-option value="workers-ai" :label="$t('aiAgentProviderWorkersAI')" />
            <el-option value="cf-ai-gateway" :label="$t('aiAgentProviderAIGateway')" />
            <el-option value="openai-compatible" :label="$t('aiAgentProviderCustom')" />
          </el-select>
          <p class="muted">
            <span v-if="local.agentProvider === 'workers-ai'">{{ $t('aiAgentWorkersAIHint') }}</span>
            <span v-else-if="local.agentProvider === 'cf-ai-gateway'">{{ $t('aiAgentAIGatewayHint') }}</span>
            <span v-else>{{ $t('aiAgentCustomHint') }}</span>
          </p>
        </el-form-item>

        <!-- Cloudflare AI Gateway Fields -->
        <template v-if="local.agentProvider === 'cf-ai-gateway'">
          <div class="provider-box">
            <el-form-item :label="$t('aiAgentCfAccountId')" required>
              <el-input
                v-model="local.agentCfAccountId"
                :placeholder="$t('aiAgentCfAccountIdPlaceholder')"
                clearable
              />
            </el-form-item>

            <el-form-item :label="$t('aiAgentAiGatewayId')" required>
              <el-input
                v-model="local.agentAiGatewayId"
                :placeholder="$t('aiAgentAiGatewayIdPlaceholder')"
                clearable
              />
            </el-form-item>

            <el-form-item :label="$t('aiAgentGatewayProvider')">
              <el-select
                v-model="selectedGatewayType"
                @change="onGatewayTypeChange"
                style="width: 100%;"
              >
                <el-option
                  v-for="item in gatewayProviderPresets"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
              <p class="muted">{{ $t('aiAgentGatewayProviderHelp') }}</p>
            </el-form-item>

            <el-form-item
              v-if="selectedGatewayType === 'custom'"
              :label="$t('aiAgentGatewayCustomProvider')"
              required
            >
              <el-input
                v-model="customGatewayName"
                :placeholder="$t('aiAgentGatewayCustomProviderPlaceholder')"
                @input="onCustomGatewayNameInput"
                @blur="onCustomGatewayNameBlur"
                clearable
              />
              <p class="muted">{{ $t('aiAgentGatewayCustomProviderHelp') }}</p>
            </el-form-item>

            <el-form-item :label="$t('aiAgentApiKey')">
              <div style="display: flex; gap: 8px; width: 100%;">
                <el-input
                  v-model="local.agentApiKey"
                  type="password"
                  show-password
                  :placeholder="clearApiKeyRequested ? $t('aiAgentApiKeyCleared') : (store.settings.hasApiKey ? store.settings.agentApiKeyMasked + ' (' + $t('aiAgentKeepSavedKey') + ')' : $t('aiAgentApiKeyPlaceholder') + ' (可选)')"
                  clearable
                  @input="clearApiKeyRequested = false"
                />
                <el-button
                  v-if="store.settings.hasApiKey && !clearApiKeyRequested"
                  size="small"
                  type="danger"
                  text
                  @click="onClearApiKey"
                >
                  {{ $t('aiAgentClearKey') }}
                </el-button>
                <el-button
                  v-else-if="clearApiKeyRequested"
                  size="small"
                  type="info"
                  text
                  @click="clearApiKeyRequested = false"
                >
                  {{ $t('aiAgentRestoreKey') }}
                </el-button>
              </div>
              <p v-if="endpointChanged && store.settings.hasApiKey && !local.agentApiKey" style="color: #e6a23c; font-size: 12px; margin-top: 4px; line-height: 1.4;">
                ⚠️ {{ $t('aiAgentEndpointChangedWarning') }}
              </p>
            </el-form-item>
          </div>
        </template>

        <!-- Custom OpenAI Compatible Fields -->
        <template v-if="local.agentProvider === 'openai-compatible'">
          <div class="provider-box">
            <el-form-item :label="$t('aiAgentBaseUrl')" required>
              <el-input
                v-model="local.agentBaseUrl"
                :placeholder="$t('aiAgentBaseUrlPlaceholder')"
                clearable
              />
            </el-form-item>

            <el-form-item :label="$t('aiAgentApiKey')" required>
              <div style="display: flex; gap: 8px; width: 100%;">
                <el-input
                  v-model="local.agentApiKey"
                  type="password"
                  show-password
                  :placeholder="clearApiKeyRequested ? $t('aiAgentApiKeyCleared') : (store.settings.hasApiKey ? store.settings.agentApiKeyMasked + ' (' + $t('aiAgentKeepSavedKey') + ')' : $t('aiAgentApiKeyPlaceholder'))"
                  clearable
                  @input="clearApiKeyRequested = false"
                />
                <el-button
                  v-if="store.settings.hasApiKey && !clearApiKeyRequested"
                  size="small"
                  type="danger"
                  text
                  @click="onClearApiKey"
                >
                  {{ $t('aiAgentClearKey') }}
                </el-button>
                <el-button
                  v-else-if="clearApiKeyRequested"
                  size="small"
                  type="info"
                  text
                  @click="clearApiKeyRequested = false"
                >
                  {{ $t('aiAgentRestoreKey') }}
                </el-button>
              </div>
              <p v-if="endpointChanged && store.settings.hasApiKey && !local.agentApiKey" style="color: #e6a23c; font-size: 12px; margin-top: 4px; line-height: 1.4;">
                ⚠️ {{ $t('aiAgentEndpointChangedWarning') }}
              </p>
            </el-form-item>
          </div>
        </template>

        <!-- Model Selection with Dynamic Fetch and Test Buttons -->
        <el-form-item :label="$t('aiAgentModel')">
          <div class="model-row">
            <el-select
              v-model="local.agentModel"
              filterable
              allow-create
              default-first-option
              :placeholder="$t('aiAgentModelPlaceholder')"
              :loading="fetchingModels"
              style="flex: 1; min-width: 220px;"
            >
              <el-option
                v-for="item in modelOptions"
                :key="item.id"
                :label="item.name || item.id"
                :value="item.id"
              />
            </el-select>
            <el-button
              type="primary"
              plain
              :loading="fetchingModels"
              @click="onFetchModels(true)"
            >
              🔄 {{ $t('aiAgentFetchModels') }}
            </el-button>
            <el-button
              type="success"
              plain
              :loading="testingConnection"
              @click="onTestConnection"
            >
              ⚡ {{ $t('aiAgentTestConnection') }}
            </el-button>
          </div>

          <!-- Connection Test Feedback Alert -->
          <div v-if="testResult" class="test-feedback" :class="testResult.success ? 'success' : 'error'">
            <span v-if="testResult.success">
              ✅ <strong>{{ $t('aiAgentTestSuccess') }}</strong>：响应耗时 {{ testResult.latencyMs }}ms
              <span v-if="testResult.reply" class="test-reply">（返回: "{{ testResult.reply }}"）</span>
            </span>
            <span v-else>
              ❌ <strong>{{ $t('aiAgentTestFailed') }}</strong>：{{ testResult.error }}
            </span>
          </div>

          <p class="muted">
            <span v-if="local.agentProvider === 'workers-ai'">推荐使用 Kimi K2.5 等支持工具调用的模型。</span>
            <span v-else>点击「拉取模型列表」通过 API 自动读取可用模型；点击「测试连接」验证 API 与 Key 是否有效；亦可直接在下拉框中手动输入任意模型 ID。</span>
          </p>
        </el-form-item>

        <!-- Auto Draft Reply -->
        <el-form-item :label="$t('aiAgentAutoDraft')">
          <el-switch v-model="local.agentAutoDraft" />
          <p class="muted">{{ $t('aiAgentAutoDraftHelp') }}</p>
        </el-form-item>

        <!-- Persona / Instructions -->
        <el-form-item :label="$t('aiAgentPersona')">
          <el-input
            type="textarea"
            v-model="local.agentPersona"
            :rows="5"
            maxlength="4000"
            show-word-limit
            :placeholder="$t('aiAgentPersonaPlaceholder')"
          />
        </el-form-item>
      </template>

      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">{{ $t('aiAgentSave') }}</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
.agent-settings { padding: 20px; }
.muted { color: #6b7280; font-size: 12px; margin-top: 4px; line-height: 1.4; }
.provider-box {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 18px;
}
.model-row {
  display: flex;
  gap: 10px;
  width: 100%;
  flex-wrap: wrap;
}
.test-feedback {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.4;
}
.test-feedback.success {
  background-color: #f0fdf4;
  border: 1px solid #bbf7d0;
  color: #166534;
}
.test-feedback.error {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}
.test-reply {
  color: #4b5563;
  margin-left: 4px;
}
</style>
