<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useAgentStore } from '@/store/agent';

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
    ElMessage.success('AI Agent settings saved');
  } catch (e) {
    ElMessage.error('Save failed: ' + (e.message || e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="agent-settings">
    <h2>✨ AI Email Agent</h2>
    <p class="hint">Powered by Cloudflare Workers AI · model: <code>@cf/moonshotai/kimi-k2.5</code></p>

    <el-form label-position="top" style="max-width: 600px;">
      <el-form-item label="Enable AI agent (side panel)">
        <el-switch v-model="local.agentEnabled" />
        <p class="muted">Adds a side panel with 9 email tools: list/search/read attachments/summarize/draft/send/delete. Sending and deleting always require explicit confirmation.</p>
      </el-form-item>

      <el-form-item label="Auto-draft replies on new email">
        <el-switch v-model="local.agentAutoDraft" :disabled="!local.agentEnabled" />
        <p class="muted">When a new email arrives, the agent reads it and generates a draft reply. The draft is saved to your Drafts mailbox — it is <b>never sent automatically</b>.</p>
      </el-form-item>

      <el-form-item label="Persona / writing instructions">
        <el-input
          type="textarea"
          v-model="local.agentPersona"
          :rows="6"
          maxlength="4000"
          show-word-limit
          placeholder="e.g. 'Sign as Andrew. Keep replies under 80 words. Match the sender's language.'"
          :disabled="!local.agentEnabled"
        />
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">Save</el-button>
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
