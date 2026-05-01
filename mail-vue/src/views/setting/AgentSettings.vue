<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAgentStore } from '@/store/agent';

const { t } = useI18n();

const store = useAgentStore();
const local = ref({ agentEnabled: false, agentAutoDraft: false, agentPersona: '' });
const saving = ref(false);

onMounted(async () => {
  if (!store.hydrated) await store.hydrate();
  local.value = { ...store.settings };
});

async function save() {
  saving.value = true;
  try {
    await store.saveSettings(local.value);
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
    <p class="hint">{{ $t('aiAgentPoweredBy') }} <code>@cf/moonshotai/kimi-k2.5</code></p>

    <el-form label-position="top" style="max-width: 600px;">
      <el-form-item :label="$t('aiAgentEnable')">
        <el-switch v-model="local.agentEnabled" />
        <p class="muted">{{ $t('aiAgentEnableHelp') }}</p>
      </el-form-item>

      <el-form-item :label="$t('aiAgentAutoDraft')">
        <el-switch v-model="local.agentAutoDraft" :disabled="!local.agentEnabled" />
        <p class="muted">{{ $t('aiAgentAutoDraftHelp') }}</p>
      </el-form-item>

      <el-form-item :label="$t('aiAgentPersona')">
        <el-input
          type="textarea"
          v-model="local.agentPersona"
          :rows="6"
          maxlength="4000"
          show-word-limit
          :placeholder="$t('aiAgentPersonaPlaceholder')"
          :disabled="!local.agentEnabled"
        />
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">{{ $t('aiAgentSave') }}</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
.agent-settings { padding: 20px; }
.hint { color: #6b7280; font-size: 13px; }
.muted { color: #6b7280; font-size: 12px; margin-top: 4px; }
code { background: #f3f4f6; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
</style>
