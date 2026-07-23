import type { PracticeContext } from "@/types/conversation";

export type FaithfulTranslationGoldenCase = {
  id: string;
  context: PracticeContext;
  category:
    | "subject_address"
    | "speech_act"
    | "negation"
    | "request_permission"
    | "time_state"
    | "quantity_ownership"
    | "action_location"
    | "incomplete"
    | "regional_colloquial"
    | "no_answer_inference";
  vietnamese: string;
  expectedEnglish: string;
  rejectedEnglish: string;
  criticalCriteria: string[];
  exactRuleEligible: boolean;
};

export const faithfulTranslationGoldenSet: FaithfulTranslationGoldenCase[] = [
  { id: "V1-001", context: "outside", category: "subject_address", vietnamese: "Mẹ ơi, con muốn mua cái này.", expectedEnglish: "Mom, I want to buy this.", rejectedEnglish: "Can we buy this?", criticalCriteria: ["subject", "addressee", "speech_act"], exactRuleEligible: true },
  { id: "V1-002", context: "home", category: "subject_address", vietnamese: "Bố ơi, con muốn về nhà.", expectedEnglish: "Dad, I want to go home.", rejectedEnglish: "Dad, let's go home.", criticalCriteria: ["subject", "speech_act"], exactRuleEligible: true },
  { id: "V1-003", context: "home", category: "subject_address", vietnamese: "Bà ơi, con nhớ bà.", expectedEnglish: "Grandma, I miss you.", rejectedEnglish: "Grandma misses me.", criticalCriteria: ["subject", "object"], exactRuleEligible: true },
  { id: "V1-004", context: "school", category: "subject_address", vietnamese: "Cô ơi, con không hiểu chỗ này.", expectedEnglish: "Teacher, I don't understand this part.", rejectedEnglish: "Teacher, this part is difficult.", criticalCriteria: ["addressee", "negation", "action"], exactRuleEligible: true },
  { id: "V1-005", context: "home", category: "subject_address", vietnamese: "Em con lấy đồ chơi của con.", expectedEnglish: "My younger sibling took my toy.", rejectedEnglish: "I took my younger sibling's toy.", criticalCriteria: ["subject", "ownership"], exactRuleEligible: true },

  { id: "V1-006", context: "outside", category: "speech_act", vietnamese: "Mẹ ơi, mình mua cái này được không?", expectedEnglish: "Mom, can we buy this?", rejectedEnglish: "Mom, I want to buy this.", criticalCriteria: ["addressee", "speech_act"], exactRuleEligible: true },
  { id: "V1-007", context: "outside", category: "speech_act", vietnamese: "Con thích chiếc áo màu xanh này.", expectedEnglish: "I like this blue shirt.", rejectedEnglish: "Do you like this blue shirt?", criticalCriteria: ["speech_act", "object"], exactRuleEligible: true },
  { id: "V1-008", context: "home", category: "speech_act", vietnamese: "Đây có phải sách của mẹ không?", expectedEnglish: "Is this your book, Mom?", rejectedEnglish: "This is Mom's book.", criticalCriteria: ["speech_act", "ownership"], exactRuleEligible: true },
  { id: "V1-009", context: "outside", category: "speech_act", vietnamese: "Hôm nay mình đi đâu vậy?", expectedEnglish: "Where are we going today?", rejectedEnglish: "Let's go somewhere today.", criticalCriteria: ["speech_act", "time"], exactRuleEligible: true },
  { id: "V1-010", context: "home", category: "speech_act", vietnamese: "Con được mở hộp này không?", expectedEnglish: "May I open this box?", rejectedEnglish: "I can open this box.", criticalCriteria: ["speech_act", "action"], exactRuleEligible: true },

  { id: "V1-011", context: "home", category: "negation", vietnamese: "Con không muốn ăn món này nữa.", expectedEnglish: "I don't want to eat this dish anymore.", rejectedEnglish: "I want to eat this dish.", criticalCriteria: ["negation", "state"], exactRuleEligible: true },
  { id: "V1-012", context: "home", category: "negation", vietnamese: "Con chưa ăn sáng.", expectedEnglish: "I haven't eaten breakfast yet.", rejectedEnglish: "I didn't eat breakfast.", criticalCriteria: ["negation", "time"], exactRuleEligible: true },
  { id: "V1-013", context: "home", category: "negation", vietnamese: "Đừng tắt đèn nhé bố.", expectedEnglish: "Dad, please don't turn off the light.", rejectedEnglish: "Dad, please turn off the light.", criticalCriteria: ["negation", "addressee"], exactRuleEligible: true },
  { id: "V1-014", context: "home", category: "negation", vietnamese: "Con không làm vỡ cái cốc.", expectedEnglish: "I didn't break the glass.", rejectedEnglish: "I broke the glass.", criticalCriteria: ["negation", "subject"], exactRuleEligible: true },
  { id: "V1-015", context: "outside", category: "negation", vietnamese: "Không phải cái này, là cái kia.", expectedEnglish: "Not this one, that one.", rejectedEnglish: "This one is fine.", criticalCriteria: ["negation", "object"], exactRuleEligible: true },

  { id: "V1-016", context: "home", category: "request_permission", vietnamese: "Mẹ mở cửa giúp con với.", expectedEnglish: "Mom, please open the door for me.", rejectedEnglish: "Mom, the door is open.", criticalCriteria: ["speech_act", "actor"], exactRuleEligible: true },
  { id: "V1-017", context: "outside", category: "request_permission", vietnamese: "Con ra ngoài chơi được không ạ?", expectedEnglish: "May I go outside to play?", rejectedEnglish: "I am going outside to play.", criticalCriteria: ["speech_act", "action"], exactRuleEligible: true },
  { id: "V1-018", context: "home", category: "request_permission", vietnamese: "Chờ con một chút nhé.", expectedEnglish: "Please wait for me for a moment.", rejectedEnglish: "I will wait for you.", criticalCriteria: ["subject", "recipient"], exactRuleEligible: true },
  { id: "V1-019", context: "home", category: "request_permission", vietnamese: "Bố giúp con mang giày được không?", expectedEnglish: "Dad, can you help me put on my shoes?", rejectedEnglish: "Dad, can I put on your shoes?", criticalCriteria: ["subject", "ownership", "speech_act"], exactRuleEligible: true },
  { id: "V1-020", context: "outside", category: "request_permission", vietnamese: "Cho con cầm cái đó với.", expectedEnglish: "Please let me hold that.", rejectedEnglish: "Give me that.", criticalCriteria: ["speech_act", "action"], exactRuleEligible: true },

  { id: "V1-021", context: "school", category: "time_state", vietnamese: "Hôm qua con quên sách ở trường.", expectedEnglish: "I left my book at school yesterday.", rejectedEnglish: "I forgot my book today.", criticalCriteria: ["time", "location"], exactRuleEligible: true },
  { id: "V1-022", context: "home", category: "time_state", vietnamese: "Ngày mai con sẽ sang nhà bà.", expectedEnglish: "I will go to Grandma's house tomorrow.", rejectedEnglish: "I went to Grandma's house yesterday.", criticalCriteria: ["time", "location"], exactRuleEligible: true },
  { id: "V1-023", context: "school", category: "time_state", vietnamese: "Con đang làm bài tập.", expectedEnglish: "I am doing my homework.", rejectedEnglish: "I finished my homework.", criticalCriteria: ["action_state"], exactRuleEligible: true },
  { id: "V1-024", context: "school", category: "time_state", vietnamese: "Con làm bài tập xong rồi.", expectedEnglish: "I have finished my homework.", rejectedEnglish: "I am doing my homework.", criticalCriteria: ["action_state"], exactRuleEligible: true },
  { id: "V1-025", context: "home", category: "time_state", vietnamese: "Mẹ chờ con năm phút nhé.", expectedEnglish: "Mom, please wait for me for five minutes.", rejectedEnglish: "Mom, please wait for a moment.", criticalCriteria: ["time", "quantity"], exactRuleEligible: true },

  { id: "V1-026", context: "home", category: "quantity_ownership", vietnamese: "Con muốn hai cái bánh.", expectedEnglish: "I want two cakes.", rejectedEnglish: "I want a cake.", criticalCriteria: ["quantity"], exactRuleEligible: true },
  { id: "V1-027", context: "school", category: "quantity_ownership", vietnamese: "Có ba bạn đang chờ con ở cổng.", expectedEnglish: "Three friends are waiting for me at the gate.", rejectedEnglish: "A friend is waiting for me outside.", criticalCriteria: ["quantity", "location"], exactRuleEligible: true },
  { id: "V1-028", context: "school", category: "quantity_ownership", vietnamese: "Cái ba lô màu đỏ là của con.", expectedEnglish: "The red backpack is mine.", rejectedEnglish: "The red backpack is yours.", criticalCriteria: ["ownership", "color"], exactRuleEligible: true },
  { id: "V1-029", context: "home", category: "quantity_ownership", vietnamese: "Một cái cho con và một cái cho em gái.", expectedEnglish: "One for me and one for my little sister.", rejectedEnglish: "Two for me.", criticalCriteria: ["quantity", "recipient"], exactRuleEligible: true },
  { id: "V1-030", context: "home", category: "quantity_ownership", vietnamese: "Điện thoại của bố ở trên bàn.", expectedEnglish: "Dad's phone is on the table.", rejectedEnglish: "My phone is on the table.", criticalCriteria: ["ownership", "location"], exactRuleEligible: true },

  { id: "V1-031", context: "home", category: "action_location", vietnamese: "Mẹ đang ở trong bếp.", expectedEnglish: "Mom is in the kitchen.", rejectedEnglish: "Mom is cooking.", criticalCriteria: ["location", "no_inference"], exactRuleEligible: true },
  { id: "V1-032", context: "home", category: "action_location", vietnamese: "Con mèo nằm dưới gầm bàn.", expectedEnglish: "The cat is under the table.", rejectedEnglish: "The cat is on the table.", criticalCriteria: ["location"], exactRuleEligible: true },
  { id: "V1-033", context: "outside", category: "action_location", vietnamese: "Con đi xe đạp đến công viên.", expectedEnglish: "I ride my bike to the park.", rejectedEnglish: "I walk to the park.", criticalCriteria: ["action", "transport"], exactRuleEligible: true },
  { id: "V1-034", context: "school", category: "action_location", vietnamese: "Mang quyển sách này vào lớp giúp con với.", expectedEnglish: "Please bring this book into the classroom for me.", rejectedEnglish: "Please take this book home.", criticalCriteria: ["action", "location", "object"], exactRuleEligible: true },
  { id: "V1-035", context: "outside", category: "action_location", vietnamese: "Ngoài trời đang mưa nên con không muốn ra ngoài.", expectedEnglish: "It is raining outside, so I don't want to go out.", rejectedEnglish: "It is raining, so we can't go out.", criticalCriteria: ["subject", "negation", "reason"], exactRuleEligible: true },

  { id: "V1-036", context: "home", category: "incomplete", vietnamese: "Mẹ ơi, cái này...", expectedEnglish: "Mom, this...", rejectedEnglish: "Mom, I want this.", criticalCriteria: ["no_inference", "addressee"], exactRuleEligible: false },
  { id: "V1-037", context: "home", category: "incomplete", vietnamese: "Con muốn...", expectedEnglish: "I want...", rejectedEnglish: "I want some water.", criticalCriteria: ["no_inference", "subject"], exactRuleEligible: false },
  { id: "V1-038", context: "home", category: "incomplete", vietnamese: "Bố ơi, con không...", expectedEnglish: "Dad, I don't...", rejectedEnglish: "Dad, I don't want to go.", criticalCriteria: ["no_inference", "negation"], exactRuleEligible: false },
  { id: "V1-039", context: "home", category: "incomplete", vietnamese: "Cái đó là của...", expectedEnglish: "That belongs to...", rejectedEnglish: "That belongs to me.", criticalCriteria: ["no_inference", "ownership"], exactRuleEligible: false },
  { id: "V1-040", context: "outside", category: "incomplete", vietnamese: "Ở đằng kia có một...", expectedEnglish: "Over there, there is a...", rejectedEnglish: "There is a dog over there.", criticalCriteria: ["no_inference", "location"], exactRuleEligible: false },

  { id: "V1-041", context: "home", category: "regional_colloquial", vietnamese: "Má ơi, con khát nước quá.", expectedEnglish: "Mom, I'm so thirsty.", rejectedEnglish: "Mom, can I have some water?", criticalCriteria: ["regional", "speech_act"], exactRuleEligible: true },
  { id: "V1-042", context: "school", category: "regional_colloquial", vietnamese: "Ba ơi, chở con đi học nha.", expectedEnglish: "Dad, please take me to school.", rejectedEnglish: "Dad, let's go to school.", criticalCriteria: ["regional", "subject"], exactRuleEligible: true },
  { id: "V1-043", context: "home", category: "regional_colloquial", vietnamese: "Con hổng có lấy đồ chơi của em.", expectedEnglish: "I didn't take my younger sibling's toy.", rejectedEnglish: "I took my younger sibling's toy.", criticalCriteria: ["regional", "negation", "ownership"], exactRuleEligible: true },
  { id: "V1-044", context: "outside", category: "regional_colloquial", vietnamese: "Ngoại ơi, con qua nhà bạn chơi được hông?", expectedEnglish: "Grandma, can I go to my friend's house?", rejectedEnglish: "Grandma, I am going to my friend's house.", criticalCriteria: ["regional", "speech_act"], exactRuleEligible: true },
  { id: "V1-045", context: "home", category: "regional_colloquial", vietnamese: "Bữa nay con mệt quá.", expectedEnglish: "I'm very tired today.", rejectedEnglish: "I was tired yesterday.", criticalCriteria: ["regional", "time", "degree"], exactRuleEligible: true },

  { id: "V1-046", context: "outside", category: "no_answer_inference", vietnamese: "Mẹ ơi, tại sao trời mưa?", expectedEnglish: "Mom, why is it raining?", rejectedEnglish: "Because there are clouds in the sky.", criticalCriteria: ["no_answer", "speech_act"], exactRuleEligible: true },
  { id: "V1-047", context: "home", category: "no_answer_inference", vietnamese: "Bố có yêu con không?", expectedEnglish: "Dad, do you love me?", rejectedEnglish: "Of course Dad loves you.", criticalCriteria: ["no_answer", "subject"], exactRuleEligible: true },
  { id: "V1-048", context: "outside", category: "no_answer_inference", vietnamese: "Con nên chọn cái nào?", expectedEnglish: "Which one should I choose?", rejectedEnglish: "You should choose the blue one.", criticalCriteria: ["no_answer", "speech_act"], exactRuleEligible: true },
  { id: "V1-049", context: "school", category: "no_answer_inference", vietnamese: "Cô ơi, chữ này đọc thế nào?", expectedEnglish: "Teacher, how do you pronounce this word?", rejectedEnglish: "This word is pronounced apple.", criticalCriteria: ["no_answer", "addressee"], exactRuleEligible: true },
  { id: "V1-050", context: "school", category: "no_answer_inference", vietnamese: "Nếu con làm sai thì sao?", expectedEnglish: "What happens if I make a mistake?", rejectedEnglish: "Don't worry, everything will be fine.", criticalCriteria: ["no_answer", "speech_act"], exactRuleEligible: true },
];

