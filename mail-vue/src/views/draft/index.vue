<template>
  <emailScroll ref="scroll"
               :allow-star="false"
               :getEmailList="getEmailList"
               :emailDelete="emailDelete"
               :star-add="starAdd"
               :star-cancel="starCancel"
               @jump="jumpContent"
               actionLeft="6px"
               :show-account-icon="false"
               :show-first-loading="false"
               :showStar="false"
               @delete-draft="deleteDraft"
               :type="'draft'"
  >
    <template #name="props">
      <span class="send-email">{{ props.email.receiveEmail?.join(',') || '(' + $t('noRecipient') + ')' }}</span>
    </template>
    <template #subject="props">
      {{ props.email.subject || '(' + $t('noSubject') + ')' }}
    </template>
  </emailScroll>
</template>

<script setup>
import emailScroll from "@/components/email-scroll/index.vue"
import {emailDelete, emailDraftList} from "@/request/email.js";
import {starAdd, starCancel} from "@/request/star.js";
import {defineOptions, ref, watch, toRaw, onActivated} from "vue";
import {useUiStore} from "@/store/ui.js";
import {userDraftStore} from "@/store/draft.js";
import db from "@/db/db.js"

defineOptions({
  name: 'draft'
})

const draftStore = userDraftStore();
const uiStore = useUiStore();
const scroll = ref({})

let refreshTimer = null;
let isRefreshing = false;

onActivated(() => {
  scroll.value?.refreshList?.();
});

watch(() => draftStore.setDraft, async () => {
  const draft = { ...toRaw(draftStore.setDraft) };
  const draftId = draft.draftId;
  const isServerDraft = !!draft.isServerDraft;
  const serverId = draft.serverId;
  const attachments = toRaw(draftStore.setDraft.attachments) || [];

  delete draft.draftId;
  delete draft.attachments;
  delete draft.isServerDraft;
  delete draft.serverId;
  delete draft.key;
  delete draft.origEmailId;
  delete draft.checked;

  if (!draft.content && !draft.subject && !(draft.receiveEmail?.length > 0)) {
    if (isServerDraft && serverId) {
      try {
        await emailDelete(serverId);
      } catch (_) {}
    } else if (draftId && typeof draftId === 'number') {
      await db.value.draft.delete(draftId);
      await db.value.att.delete(draftId);
    }
    draftStore.refreshList++;
    return;
  }

  if (!isServerDraft) {
    if (!draft.createTime) {
      delete draft.createTime;
    }
    if (draftId && typeof draftId === 'number') {
      await db.value.draft.update(draftId, draft);
      await db.value.att.put({ draftId, attachments });
    }
  }
  draftStore.refreshList++;
}, {
  deep: true
});

async function doRefresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    const { list } = await getEmailList();
    if (scroll.value?.emailList) {
      scroll.value.emailList.length = 0;
      scroll.value.handleList(list);
      scroll.value.emailList.push(...list);
    }
  } finally {
    isRefreshing = false;
  }
}

watch(() => draftStore.refreshList, () => {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    doRefresh();
  }, 250);
});

async function getEmailList(lastId) {
  if (lastId) {
    return { list: [] };
  }

  let serverList = [];
  try {
    const res = await emailDraftList();
    if (Array.isArray(res)) {
      serverList = res;
    } else if (res && Array.isArray(res.data)) {
      serverList = res.data;
    }
  } catch (e) {
    console.error('Failed to load server drafts', e);
  }

  let localList = [];
  try {
    localList = await db.value.draft.orderBy('createTime').reverse().toArray();
  } catch (e) {
    console.error('Failed to load local drafts', e);
  }

  const formattedLocal = localList.map(item => ({
    ...item,
    isServerDraft: false,
    key: 'local-' + item.draftId,
    emailId: 'local-' + item.draftId,
    origEmailId: item.emailId || 0,
  }));

  const formattedServer = serverList.map(item => ({
    ...item,
    isServerDraft: true,
    serverId: item.serverId || item.emailId,
    key: 'server-' + (item.serverId || item.emailId),
    emailId: 'server-' + (item.serverId || item.emailId),
    origEmailId: item.replyEmailId || 0,
  }));

  const list = [...formattedLocal, ...formattedServer].sort((a, b) => {
    return (b.createTime || '').localeCompare(a.createTime || '');
  });

  return { list, total: list.length };
}

async function deleteDraft(draftKeys) {
  if (!draftKeys || draftKeys.length === 0) return;

  const serverIdsToDelete = [];
  const localIdsToDelete = [];

  for (const k of draftKeys) {
    if (typeof k === 'string') {
      if (k.startsWith('server-')) {
        const sid = Number(k.replace('server-', ''));
        if (sid > 0) serverIdsToDelete.push(sid);
      } else if (k.startsWith('local-')) {
        const lid = Number(k.replace('local-', ''));
        if (lid > 0) localIdsToDelete.push(lid);
      }
    } else if (typeof k === 'number') {
      localIdsToDelete.push(k);
    }
  }

  if (localIdsToDelete.length > 0) {
    await db.value.draft.bulkDelete(localIdsToDelete);
    await db.value.att.bulkDelete(localIdsToDelete);
  }

  if (serverIdsToDelete.length > 0) {
    try {
      await emailDelete(serverIdsToDelete.join(','));
    } catch (e) {
      console.error('Failed to delete server drafts', e);
    }
  }

  draftStore.refreshList++;
}

async function jumpContent(email) {
  if (email.isServerDraft) {
    uiStore.writerRef.openDraft({
      ...email,
      emailId: email.origEmailId || 0,
      draftId: email.serverId,
      serverId: email.serverId,
      isServerDraft: true,
      attachments: email.attachments || []
    });
    return;
  }
  const att = await db.value.att.get(email.draftId);
  const attachments = att?.attachments || [];
  uiStore.writerRef.openDraft({
    ...email,
    emailId: email.origEmailId || 0,
    attachments,
  });
}

</script>
<style>
.send-email {
  font-weight: normal;
}
</style>
