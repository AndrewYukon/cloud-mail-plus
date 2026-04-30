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
    },
  }),

  actions: {
    async hydrate() {
      try {
        const userRes = await http.get('/my/info');
        const u = userRes.data || userRes;
        this.settings.agentEnabled = !!u.agentEnabled;
        this.settings.agentAutoDraft = !!u.agentAutoDraft;
        this.settings.agentPersona = u.agentPersona || '';
        if (this.settings.agentEnabled) {
          const r = await http.get('/agent/state');
          this.messages = r.data?.messages || r.messages || [];
        }
      } catch (e) {
        console.warn('[agent.hydrate]', e);
      } finally {
        this.hydrated = true;
      }
    },

    async saveSettings(patch) {
      Object.assign(this.settings, patch);
      await http.put('/agent/settings', this.settings);
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
