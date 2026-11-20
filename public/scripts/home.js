const usernameInput = document.getElementById('username');
usernameInput.value = window.OceanProfile.load();
usernameInput.addEventListener('input', () => {
    usernameInput.value = usernameInput.value.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 16);
    window.OceanProfile.save(usernameInput.value);
});
for (const form of document.querySelectorAll('main form')) {
    form.addEventListener('submit', () => {
        usernameInput.value = window.OceanProfile.save(usernameInput.value);
    });
}
