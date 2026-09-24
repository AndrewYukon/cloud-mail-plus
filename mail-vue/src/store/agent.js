import { defineStore } from 'pinia';
import http from '@/axios/index.js';

export const useAgentStore = defineStore('agent', {
  state: () => ({
    panelVisible: false,
    hydrated: false,
    messages: [],
    settings: {
      agentEnabled: false,
      agentAutoDraft: false,
      agentPersona: '',
      agentProvider: 'workers-ai',
      agentCfAccountId: '',
      agentAiGatewayId: '',
      agentGatewayProvider: 'openai',
      agentBaseUrl: '',
      agentApiKey: '',
      agentApiKeyMasked: '',
      hasApiKey: false,
      agentModel: '',
    },
  }),

  actions: {
    async hydrate() {
      try {
        const r = await http.get('/agent/settings');
        const s = r.data || r;
        this.settings.agentEnabled = !!s.agentEnabled;
        this.settings.agentAutoDraft = !!s.agentAutoDraft;
        this.settings.agentPersona = s.agentPersona || '';
        this.settings.agentProvider = s.agentProvider || 'workers-ai';
        this.settings.agentCfAccountId = s.agentCfAccountId || '';
        this.settings.agentAiGatewayId = s.agentAiGatewayId || '';
        this.settings.agentGatewayProvider = s.agentGatewayProvider || 'openai';
        this.settings.agentBaseUrl = s.agentBaseUrl || '';
        this.settings.agentApiKeyMasked = s.agentApiKeyMasked || '';
        this.settings.hasApiKey = !!s.hasApiKey;
        this.settings.agentApiKey = ''; // Clear typed key, backend keeps it safe
        this.settings.agentModel = s.agentModel || '';
      } catch (e) {
        console.warn('[agent.hydrate]', e);
      } finally {
        this.hydrated = true;
      }
    },

    async saveSettings(patch) {
      Object.assign(this.settings, patch);
      const r = await http.put('/agent/settings', this.settings);
      // Re-hydrate to refresh masked key
      await this.hydrate();
      return r.data || r;
    },

    async fetchModels(params) {
      const r = await http.post('/agent/models', params);
      return r.data || r;
    },

    async testConnection(params) {
      const r = await http.post('/agent/test', params);
      return r.data || r;
    },

    async clear() {
      await http.post('/agent/clear');
      this.messages = [];
    },

    appendFinalized(message) {
      const idx = this.messages.findIndex(m => m.id === message.id);
      if (idx >= 0) this.messages.splice(idx, 1, message);
      else this.messages.push(message);
    },
  },

  persist: {
    paths: ['panelVisible'],
  },
});
