if (new URLSearchParams(location.search).has('projection')) {
    void import('./projection');
}
else {
    void import('./controller');
}
