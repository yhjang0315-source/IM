// 배포와 동시에 조건까지 확정하는 지름길. 체결 화면을 건너뛰고 정산 시연만 할 때 쓴다.
process.env.ACTIVATE = "1";
require("./deploy-dev");
