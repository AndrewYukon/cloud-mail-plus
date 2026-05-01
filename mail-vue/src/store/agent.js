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
        const r = await http.get('/agent/settings');
        const s = r.data || r;
        this.settings.agentEnabled = !!s.agentEnabled;
        this.settings.agentAutoDraft = !!s.agentAutoDraft;
        this.settings.agentPersona = s.agentPersona || '';
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
