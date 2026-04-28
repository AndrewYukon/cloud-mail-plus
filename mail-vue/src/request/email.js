import http from '@/axios/index.js';

export function emailList(accountId, allReceive, emailId, timeSort, size, type) {
    return http.get('/email/list', {params: {accountId, allReceive, emailId, timeSort, size, type}})
}

export function emailDelete(emailIds) {
    return http.delete('/email/delete?emailIds=' + emailIds)
}

export function emailPermanentDelete(emailIds) {
    return http.delete('/email/permanentDelete?emailIds=' + emailIds)
}

export function emailExport(emailId) {
    const token = localStorage.getItem('token')
    return fetch(`${import.meta.env.VITE_BASE_URL}/email/export?emailId=${emailId}`, {
        headers: { 'Authorization': token }
    }).then(r => {
        if (!r.ok) throw new Error('Export failed')
        return r.blob()
    })
}

export function emailBatchExport(emailIds) {
    const token = localStorage.getItem('token')
    return fetch(`${import.meta.env.VITE_BASE_URL}/email/batchExport?emailIds=${emailIds}`, {
        headers: { 'Authorization': token }
    }).then(r => {
        if (!r.ok) throw new Error('Export failed')
        return r.blob()
    })
}

export function emailLatest(emailId, accountId, allReceive) {
    return http.get('/email/latest', {params: {emailId, accountId, allReceive}, noMsg: true, timeout: 35 * 1000})
}

export function emailRead(emailIds) {
    return http.put('/email/read', {emailIds})
}

export function emailSend(form,progress) {
    return http.post('/email/send', form,{
        onUploadProgress: (e) => {
            progress(e)
        },
        noMsg: true
    })
}
