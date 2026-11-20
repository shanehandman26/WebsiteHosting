const joinCode = document.getElementById('joinCode');
joinCode.addEventListener('input', () => {
    joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});
