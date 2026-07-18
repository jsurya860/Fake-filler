// Injected into the page's MAIN world (see manifest.json) so the fetch/XHR
// patches installed here see the page's own network calls. The isolated
// world content script (index.ts) has separate fetch/XMLHttpRequest globals
// that the page never calls, so installing the interceptor there is a no-op
// — see api-interceptor.ts's API_ERROR_EVENT for how results get back out.
import { installApiInterceptor } from './api-interceptor';

installApiInterceptor();
