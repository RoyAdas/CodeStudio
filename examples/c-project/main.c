#include <stdio.h>
#include "total.h"

int main(void) {
    const int values[] = { 10, 20, 12 };
    printf("C project total: %d\n", total(values, 3));
    return 0;
}
