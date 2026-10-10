#include <stdio.h>

int main(void) {
    printf("Hello, CodeStudio!\n");

    int total = 0;
    for (int number = 1; number <= 5; ++number) {
        total += number;
    }
    printf("Sum: %d\n", total);
    return 0;
}
